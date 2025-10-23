const express = require("express");
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");

// FFmpeg Setup
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Custom Font Configuration
const CUSTOM_FONT_PATH = path.join(__dirname, "public", "fonts", "Montserrat-Bold.ttf");

// Overlay Image Configuration
const OVERLAY_IMAGE_PATH = path.join(__dirname, "image", "blackbarLucien.png");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: "50mb" }));

const TEMP_DIR = "/tmp";
const OUTPUT_DIR = path.join(TEMP_DIR, "output");

// ==================== UTILITY FUNCTIONS ====================

async function ensureDirectories() {
    await fsp.mkdir(OUTPUT_DIR, { recursive: true });
    console.log('📁 Directories ensured');
}

async function downloadFile(url, filepath) {
    console.log(`⬇️  Downloading: ${url}`);
    const response = await axios({ method: "GET", url, responseType: "stream" });
    const writer = fs.createWriteStream(filepath);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on("finish", () => {
            console.log(`✅ Downloaded: ${filepath}`);
            resolve();
        });
        writer.on("error", reject);
    });
}

async function getAudioDuration(filepath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filepath, (err, metadata) => {
            if (err) reject(err);
            else resolve(metadata.format.duration);
        });
    });
}

async function getVideoDimensions(filepath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filepath, (err, metadata) => {
            if (err) reject(err);
            else {
                const videoStream = metadata.streams.find(s => s.codec_type === 'video');
                if (!videoStream) {
                    reject(new Error('No video stream found'));
                    return;
                }
                resolve({
                    width: videoStream.width,
                    height: videoStream.height
                });
            }
        });
    });
}

async function getImageDimensions(filepath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filepath, (err, metadata) => {
            if (err) reject(err);
            else {
                const imageStream = metadata.streams.find(s => s.codec_type === 'video');
                if (!imageStream) {
                    reject(new Error('No image stream found'));
                    return;
                }
                resolve({
                    width: imageStream.width,
                    height: imageStream.height
                });
            }
        });
    });
}

/**
 * Wraps text by inserting newlines to prevent excessive width
 */
function wrapText(text, maxCharsPerLine = 30) {
    if (!text) return '';
    
    const words = text.split(' ');
    let wrappedText = '';
    let currentLineLength = 0;

    for (const word of words) {
        if (currentLineLength + word.length + 1 > maxCharsPerLine) {
            wrappedText += '\n' + word + ' ';
            currentLineLength = word.length + 1;
        } else {
            wrappedText += word + ' ';
            currentLineLength += word.length + 1;
        }
    }
    
    return wrappedText.trim();
}

/**
 * Escapes text for FFmpeg drawtext filter
 * Uses a careful approach to handle all special characters
 */
function escapeForDrawtext(text) {
    if (!text) return '';
    
    // Replace each character that needs escaping
    // Order is critical: do NOT escape backslashes first or you'll double-escape
    
    // First, handle newlines by converting to a sequence FFmpeg understands
    text = text.replace(/\n/g, '\n'); // Keep as literal newline for now
    
    // Escape characters that have special meaning in FFmpeg drawtext
    // We need to escape: ' : \ [ ] ; ,
    text = text.replace(/\\/g, '\\\\');      // Backslash
    text = text.replace(/'/g, "'\\\\''");    // Single quote (replace with '\'' which ends quote, adds escaped quote, starts quote)
    text = text.replace(/:/g, '\\:');        // Colon
    
    // NOW handle newlines - replace actual newline chars with \n sequence
    text = text.replace(/\n/g, '\\n');
    
    return text;
}

async function addMemeText(videoPath, outputPath, topText = "", bottomText = "", projectName = "") {
    return new Promise(async (resolve, reject) => {
        try {
            console.log('🎨 addMemeText function called');
            
            const needsMemeText = (topText || bottomText);
            if (!needsMemeText) {
                console.log('⚠️  No meme text provided - adding only branding');
            }

            const { width, height } = await getVideoDimensions(videoPath);
            console.log(`📐 Video dimensions: ${width}x${height}`);

            const wrappedTopText = wrapText(topText, 45);
            const wrappedBottomText = wrapText(bottomText, 45);
            
            const topLines = wrappedTopText.split('\n').filter(line => line.trim());
            const bottomLines = wrappedBottomText.split('\n').filter(line => line.trim());
            const maxLines = needsMemeText ? Math.max(topLines.length, bottomLines.length, 1) : 1;
            
            const baseDivisor = 12;
            const verticalCompressionFactor = 2;
            const dynamicDivisor = baseDivisor + ((maxLines - 1) * verticalCompressionFactor);
            
            const fontSize = Math.floor(height / dynamicDivisor);
            const strokeWidth = Math.max(2, Math.floor(fontSize / 10));
            const lineHeight = fontSize + 5;
            const verticalOffset = 20;

            console.log(`🔤 Font size: ${fontSize}, Stroke: ${strokeWidth}, Line height: ${lineHeight}`);

            const escapedFontPath = CUSTOM_FONT_PATH.replace(/:/g, '\\:');

            if (!fs.existsSync(CUSTOM_FONT_PATH)) {
                console.warn(`⚠️  Warning: Font file not found at ${CUSTOM_FONT_PATH}`);
            }

            const drawtextParams = [
                `fontfile='${escapedFontPath}'`,
                `fontcolor=white`,
                `fontsize=${fontSize}`,
                `bordercolor=black`,
                `borderw=${strokeWidth}`,
                `shadowcolor=black@0.5`,
                `shadowx=2`,
                `shadowy=2`
            ].join(':');

            // Check if overlay image exists
            console.log(`🔍 Checking for overlay image at: ${OVERLAY_IMAGE_PATH}`);
            const hasOverlay = fs.existsSync(OVERLAY_IMAGE_PATH);
            console.log(`📁 Overlay image exists: ${hasOverlay}`);
            
            if (!hasOverlay) {
                console.error('❌ Overlay image not found! Cannot proceed.');
                return reject(new Error(`Overlay image not found at ${OVERLAY_IMAGE_PATH}`));
            }

            const overlayDimensions = await getImageDimensions(OVERLAY_IMAGE_PATH);
            console.log(`📐 Overlay image dimensions: ${overlayDimensions.width}x${overlayDimensions.height}`);
            
            // Use overlay at native size (no scaling needed for 1280x720)
            const overlayWidth = overlayDimensions.width;
            const overlayHeight = overlayDimensions.height;
            
            // Position at bottom of video (centered horizontally, at bottom vertically)
            const overlayX = Math.floor((width - overlayWidth) / 2); // Center horizontally
            const overlayY = height - overlayHeight; // Bottom of video
            console.log(`📍 Overlay position: x=${overlayX}, y=${overlayY} (full frame overlay)`);
            
            // Since blackbarLucien.png is full frame (1280x720), we need to calculate where
            // the text should be positioned relative to the video frame
            
            // Calculate branding text properties - smaller font for branding
            const brandingFontSize = Math.floor(fontSize * 0.4); // 40% of meme text size
            const brandingStrokeWidth = Math.max(1, Math.floor(brandingFontSize / 12));
            
            // DYNAMIC BOTTOM LEFT TEXT: Luna.fun/memes/{projectName}
            // Sanitize project name for URL (remove spaces, special chars, convert to lowercase)
            const sanitizedProjectName = projectName ? projectName.toLowerCase().replace(/[^a-z0-9-]/g, '') : 'default';
            const bottomLeftText = `Luna.fun/memes/${sanitizedProjectName}`;
            const escapedBottomLeftText = escapeForDrawtext(bottomLeftText);
            
            console.log(`🔗 Bottom left branding: ${bottomLeftText}`);
            
            const brandingParams = [
                `fontfile='${escapedFontPath}'`,
                `fontcolor=white`,
                `fontsize=${brandingFontSize}`,
                `bordercolor=black`,
                `borderw=${brandingStrokeWidth}`
            ].join(':');
            
            // Position branding text in bottom left corner of the video
            // Add padding from edges
            const brandingPaddingX = 15;
            const brandingPaddingY = 15;
            const brandingX = brandingPaddingX;
            const brandingY = height - brandingPaddingY - brandingFontSize;

            console.log(`📍 Branding text position: x=${brandingX}, y=${brandingY}`);

            let filterComplex = `[0:v][1:v]overlay=${overlayX}:${overlayY}[v1]`;
            
            // Add bottom left branding text (always present)
            filterComplex += `;[v1]drawtext=${brandingParams}:text='${escapedBottomLeftText}':x=${brandingX}:y=${brandingY}[v2]`;
            
            let currentOutput = 'v2';
            let outputIndex = 3;

            // Add meme text if provided
            if (needsMemeText) {
                if (topText) {
                    const escapedTopText = escapeForDrawtext(wrappedTopText);
                    const topYPosition = verticalOffset;
                    filterComplex += `;[${currentOutput}]drawtext=${drawtextParams}:text='${escapedTopText}':x=(w-text_w)/2:y=${topYPosition}[v${outputIndex}]`;
                    currentOutput = `v${outputIndex}`;
                    outputIndex++;
                }

                if (bottomText) {
                    const escapedBottomText = escapeForDrawtext(wrappedBottomText);
                    const bottomYPosition = height - (bottomLines.length * lineHeight) - verticalOffset - overlayHeight;
                    filterComplex += `;[${currentOutput}]drawtext=${drawtextParams}:text='${escapedBottomText}':x=(w-text_w)/2:y=${bottomYPosition}[v${outputIndex}]`;
                    currentOutput = `v${outputIndex}`;
                }
            }

            console.log('🎬 Starting FFmpeg processing...');
            console.log(`Filter complex: ${filterComplex}`);

            ffmpeg(videoPath)
                .input(OVERLAY_IMAGE_PATH)
                .complexFilter(filterComplex)
                .outputOptions([
                    '-map', `[${currentOutput}]`,
                    '-map', '0:a?',
                    '-c:v', 'libx264',
                    '-preset', 'medium',
                    '-crf', '23',
                    '-c:a', 'copy'
                ])
                .output(outputPath)
                .on('start', (cmd) => {
                    console.log('🎥 FFmpeg command:', cmd);
                })
                .on('progress', (progress) => {
                    if (progress.percent) {
                        console.log(`⏳ Progress: ${progress.percent.toFixed(1)}%`);
                    }
                })
                .on('end', () => {
                    console.log('✅ Text overlay complete');
                    resolve();
                })
                .on('error', (err, stdout, stderr) => {
                    console.error('❌ FFmpeg error:', err.message);
                    console.error('FFmpeg stderr:', stderr);
                    reject(err);
                })
                .run();
        } catch (err) {
            console.error('❌ Error in addMemeText:', err);
            reject(err);
        }
    });
}

async function mixVideo(videoPath, dialoguePath, musicPath, outputPath) {
    return new Promise(async (resolve, reject) => {
        try {
            console.log('🎵 Starting audio mixing...');
            
            const videoDuration = await getAudioDuration(videoPath);
            console.log(`📊 Video duration: ${videoDuration}s`);

            const command = ffmpeg(videoPath);
            const filterParts = [];
            const inputMappings = ['0:v'];
            let audioInputIndex = 1;

            if (dialoguePath) {
                console.log('🎤 Adding dialogue track');
                command.input(dialoguePath);
                const dialogueDuration = await getAudioDuration(dialoguePath);
                
                if (dialogueDuration < videoDuration) {
                    const loopCount = Math.ceil(videoDuration / dialogueDuration);
                    filterParts.push(`[${audioInputIndex}:a]aloop=loop=${loopCount}:size=${Math.ceil(dialogueDuration * 48000)}[dialogue]`);
                } else {
                    filterParts.push(`[${audioInputIndex}:a]atrim=duration=${videoDuration}[dialogue]`);
                }
                audioInputIndex++;
            }

            if (musicPath) {
                console.log('🎶 Adding music track');
                command.input(musicPath);
                const musicDuration = await getAudioDuration(musicPath);
                
                if (musicDuration < videoDuration) {
                    const loopCount = Math.ceil(videoDuration / musicDuration);
                    filterParts.push(`[${audioInputIndex}:a]aloop=loop=${loopCount}:size=${Math.ceil(musicDuration * 48000)},volume=0.3[music]`);
                } else {
                    filterParts.push(`[${audioInputIndex}:a]atrim=duration=${videoDuration},volume=0.3[music]`);
                }
            }

            if (dialoguePath && musicPath) {
                filterParts.push('[dialogue][music]amix=inputs=2:duration=first[aout]');
                inputMappings.push('[aout]');
            } else if (dialoguePath) {
                inputMappings.push('[dialogue]');
            } else if (musicPath) {
                inputMappings.push('[music]');
            }

            const filterComplex = filterParts.join(';');
            console.log(`🎛️  Filter complex: ${filterComplex}`);

            command
                .complexFilter(filterComplex)
                .outputOptions([
                    '-map', inputMappings[0],
                    '-map', inputMappings[1],
                    '-c:v', 'copy',
                    '-c:a', 'aac',
                    '-b:a', '192k',
                    '-shortest'
                ])
                .output(outputPath)
                .on('start', (cmd) => {
                    console.log('🎥 FFmpeg command:', cmd);
                })
                .on('progress', (progress) => {
                    if (progress.percent) {
                        console.log(`⏳ Mixing progress: ${progress.percent.toFixed(1)}%`);
                    }
                })
                .on('end', () => {
                    console.log('✅ Audio mixing complete');
                    resolve();
                })
                .on('error', (err, stdout, stderr) => {
                    console.error('❌ FFmpeg mixing error:', err.message);
                    console.error('FFmpeg stderr:', stderr);
                    reject(err);
                })
                .run();

        } catch (err) {
            console.error('❌ Error in mixVideo:', err);
            reject(err);
        }
    });
}

// ==================== BACKEND API ENDPOINTS ====================

app.get("/health", (req, res) => {
    res.json({ 
        status: "ok", 
        message: "Video processing server is running",
        font_available: fs.existsSync(CUSTOM_FONT_PATH),
        overlay_available: fs.existsSync(OVERLAY_IMAGE_PATH)
    });
});

app.post("/stitch", async (req, res) => {
    const startTime = Date.now();
    
    console.log('\n========================================');
    console.log('📥 NEW REQUEST RECEIVED');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Request body keys:', Object.keys(req.body));
    
    try {
        await ensureDirectories();

        const { 
            final_stitched_video,
            final_dialogue,
            final_music_url,
            meme_top_text,
            meme_bottom_text,
            meme_project_name
        } = req.body;

        console.log('\n📋 Request Details:');
        console.log('   Video URL:', final_stitched_video ? '✅' : '❌');
        console.log('   Dialogue URL:', final_dialogue ? '✅' : '❌');
        console.log('   Music URL:', final_music_url ? '✅' : '❌');
        console.log('   Top Text:', meme_top_text || '(none)');
        console.log('   Bottom Text:', meme_bottom_text || '(none)');
        console.log('   Project Name:', meme_project_name || '(none)');

        if (!final_stitched_video) {
            console.error('❌ Missing video URL');
            return res.status(400).json({ error: "Missing required input: final_stitched_video" });
        }

        // Generate unique ID for this processing job
        const id = uuidv4();
        console.log('🆔 Job ID:', id);

        // Define file paths
        const videoPath = path.join(TEMP_DIR, `${id}_video.mp4`);
        const dialoguePath = final_dialogue ? path.join(TEMP_DIR, `${id}_dialogue.mp3`) : null;
        const musicPath = final_music_url ? path.join(TEMP_DIR, `${id}_music.mp3`) : null;
        const videoWithTextPath = path.join(TEMP_DIR, `${id}_with_text.mp4`);
        const outputPathWithOverlay = path.join(OUTPUT_DIR, `${id}_with_overlay.mp4`);
        const outputPathWithoutOverlay = path.join(OUTPUT_DIR, `${id}_without_overlay.mp4`);

        // Determine if meme text is needed
        const needsMemeText = (meme_top_text || meme_bottom_text) ? true : false;
        
        console.log('🔍 Processing Plan:');
        console.log('   Needs meme text:', needsMemeText);
        console.log('   Has audio:', !!(final_dialogue || final_music_url));

        // Download video
        console.log('\n📥 Downloading assets...');
        await downloadFile(final_stitched_video, videoPath);

        // Download audio files if provided
        if (final_dialogue) {
            await downloadFile(final_dialogue, dialoguePath);
        }
        if (final_music_url) {
            await downloadFile(final_music_url, musicPath);
        }

        // Generate both versions: with and without overlay
        console.log('\n🎬 Generating both versions...');
        
        // Version 1: Without overlay (original video)
        if (final_dialogue || final_music_url) {
            console.log('📦 Creating version without overlay...');
            await mixVideo(videoPath, dialoguePath, musicPath, outputPathWithoutOverlay);
        } else {
            console.log('📦 Creating version without overlay (no audio mixing)...');
            await fsp.copyFile(videoPath, outputPathWithoutOverlay);
        }

        // Version 2: With overlay (always create this version with branding)
        console.log('🎨 Creating version with overlay and branding...');
        await addMemeText(videoPath, videoWithTextPath, meme_top_text, meme_bottom_text, meme_project_name);
        
        if (final_dialogue || final_music_url) {
            await mixVideo(videoWithTextPath, dialoguePath, musicPath, outputPathWithOverlay);
        } else {
            await fsp.copyFile(videoWithTextPath, outputPathWithOverlay);
        }

        // Clean up temporary files
        console.log('\n🧹 Cleaning up temporary files...');
        try {
            await fsp.unlink(videoPath);
            if (dialoguePath) await fsp.unlink(dialoguePath);
            if (musicPath) await fsp.unlink(musicPath);
            if (needsMemeText) await fsp.unlink(videoWithTextPath);
        } catch (cleanupErr) {
            console.warn('⚠️  Cleanup warning:', cleanupErr.message);
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`\n✅ Processing complete in ${duration}s`);
        console.log('========================================\n');

        // Prepare response with both outputs
        const response = {
            success: true,
            message: "Two videos created: one with branding/overlay and one without",
            processing_time: `${duration}s`,
            job_id: id,
            downloads: {
                without_overlay: `/download/${path.basename(outputPathWithoutOverlay)}`,
                with_overlay: `/download/${path.basename(outputPathWithOverlay)}`
            }
        };

        res.json(response);

    } catch (err) {
        console.error('\n❌ PROCESSING FAILED');
        console.error('Error:', err.message);
        console.error('Stack:', err.stack);
        console.log('========================================\n');
        
        res.status(500).json({ 
            success: false,
            error: "Processing failed", 
            details: err.message 
        });
    }
});

// ==================== FRONTEND API ENDPOINTS ====================

// Configure multer for file uploads
const upload = multer({ dest: TEMP_DIR });

// Store for tracking video creation jobs
const videoJobs = new Map();

// Create video endpoint (for frontend)
app.post("/api/create-video", upload.single('image'), async (req, res) => {
    try {
        const { username, tweet, projectName } = req.body;
        const imageFile = req.file;
        const imageUrl = req.body.imageUrl;

        if (!username || !tweet) {
            return res.status(400).json({ error: "Username and tweet are required" });
        }

        // Generate UUID for this job
        const uuid = uuidv4();
        
        // Store job info
        videoJobs.set(uuid, {
            status: 'processing',
            username,
            tweet,
            projectName: projectName || 'default',
            imageFile: imageFile ? imageFile.path : null,
            imageUrl: imageUrl || null,
            created_at: new Date()
        });

        console.log(`🎬 New video job created: ${uuid}`);
        
        // Start processing in background
        processVideoJob(uuid);

        res.json({ uuid, status: 'processing' });
    } catch (error) {
        console.error('Error creating video job:', error);
        res.status(500).json({ error: 'Failed to create video job' });
    }
});

// Status endpoint
app.get("/api/status/:uuid", (req, res) => {
    const { uuid } = req.params;
    const job = videoJobs.get(uuid);
    
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    
    res.json(job);
});

// Background processing function
async function processVideoJob(uuid) {
    try {
        const job = videoJobs.get(uuid);
        if (!job) return;

        console.log(`🎬 Processing video job: ${uuid}`);
        
        await ensureDirectories();
        
        // For demo purposes, we'll create placeholder files
        // In a real implementation, you would:
        // 1. Process the uploaded image
        // 2. Generate video with the image and text
        // 3. Create both versions (with and without overlay)
        
        const outputPathWithoutOverlay = path.join(OUTPUT_DIR, `${uuid}_without_overlay.mp4`);
        const outputPathWithOverlay = path.join(OUTPUT_DIR, `${uuid}_with_overlay.mp4`);
        
        // Create placeholder files
        await fsp.writeFile(outputPathWithoutOverlay, '');
        await fsp.writeFile(outputPathWithOverlay, '');
        
        console.log(`📝 Project name for branding: ${job.projectName}`);
        
        // Update job status with both versions
        job.status = 'stitched';
        job.downloads = {
            without_overlay: `/download/${uuid}_without_overlay.mp4`,
            with_overlay: `/download/${uuid}_with_overlay.mp4`
        };
        job.completed_at = new Date();
        
        console.log(`✅ Video job completed: ${uuid}`);
        
    } catch (error) {
        console.error(`❌ Error processing video job ${uuid}:`, error);
        const job = videoJobs.get(uuid);
        if (job) {
            job.status = 'failed';
            job.error_message = error.message;
        }
    }
}

// Serve the output videos
app.use("/download", express.static(OUTPUT_DIR));

// Start server
app.listen(PORT, () => {
    console.log('========================================');
    console.log(`🚀 Video Processing Server`);
    console.log(`📍 Running on: http://localhost:${PORT}`);
    console.log(`🏥 Health check: http://localhost:${PORT}/health`);
    console.log(`📁 Output directory: ${OUTPUT_DIR}`);
    console.log(`🎨 Font path: ${CUSTOM_FONT_PATH}`);
    console.log('========================================\n');
});

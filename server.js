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
const OVERLAY_IMAGE_PATH = path.join(__dirname, "image", "2.png");

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

            const wrappedTopText = wrapText(topText, 30);
            const wrappedBottomText = wrapText(bottomText, 30);
            
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
            console.log(`📍 Overlay position: x=${overlayX}, y=${overlayY} (centered at bottom)`);

            // Build filter_complex as a single string with semicolons
            let filterParts = [];
            
            // Part 1: Load overlay image (no scaling needed)
            const escapedImagePath = OVERLAY_IMAGE_PATH.replace(/:/g, '\\:');
            filterParts.push(`movie=${escapedImagePath}[ovr]`);
            
            // Part 2: Overlay image on video
            filterParts.push(`[0:v][ovr]overlay=${overlayX}:${overlayY}[base]`);
            
            // Part 3: Add all text layers
            let currentLabel = 'base';
            let labelCounter = 1;
            
            // Top text
            if (needsMemeText && topText && topLines.length > 0) {
                topLines.forEach((line, index) => {
                    const escapedLine = escapeTextSimple(line);
                    const yPos = verticalOffset + (index * lineHeight);
                    const nextLabel = `txt${labelCounter}`;
                    filterParts.push(`[${currentLabel}]drawtext=${drawtextParams}:text='${escapedLine}':x=(w-text_w)/2:y=${yPos}[${nextLabel}]`);
                    currentLabel = nextLabel;
                    labelCounter++;
                });
            }
            
            // Bottom text - position ABOVE the overlay bar
            if (needsMemeText && bottomText && bottomLines.length > 0) {
                const totalBottomHeight = bottomLines.length * lineHeight;
                const bottomOffset = overlayHeight + 20; // 20px above overlay
                bottomLines.forEach((line, index) => {
                    const escapedLine = escapeTextSimple(line);
                    const yPos = height - totalBottomHeight - bottomOffset + (index * lineHeight);
                    const nextLabel = `txt${labelCounter}`;
                    filterParts.push(`[${currentLabel}]drawtext=${drawtextParams}:text='${escapedLine}':x=(w-text_w)/2:y=${yPos}[${nextLabel}]`);
                    currentLabel = nextLabel;
                    labelCounter++;
                });
            }
            
            // Part 4: Add branding text on overlay bar
            const brandingText = projectName ? `luna.fun/${projectName}` : "luna.fun";
            const brandingFontSize = Math.max(28, Math.floor(fontSize * 0.9)); // Large and prominent
            const brandingStrokeWidth = Math.max(2, Math.floor(brandingFontSize / 12));
            
            const brandingParams = [
                `fontfile='${escapedFontPath}'`,
                `fontcolor=white`,
                `fontsize=${brandingFontSize}`,
                `bordercolor=black`,
                `borderw=${brandingStrokeWidth}`,
                `shadowcolor=black@0.7`,
                `shadowx=3`,
                `shadowy=3`
            ].join(':');

            const escapedBrandingText = escapeTextSimple(brandingText);
            // Center branding text on the overlay bar
            const brandingY = overlayY + Math.floor(overlayHeight / 2); // Vertically centered on overlay
            
            // Final text overlay - no output label (goes to output)
            filterParts.push(`[${currentLabel}]drawtext=${brandingParams}:text='${escapedBrandingText}':x=(w-text_w)/2:y=${brandingY}-text_h/2`);
            
            // Join all parts with semicolons
            const filterComplex = filterParts.join(';');
            
            console.log('🎬 Filter complex string:');
            console.log(filterComplex);
            console.log(`📊 Branding "${brandingText}" centered on overlay bar at y=${brandingY}`);

            // Execute FFmpeg
            ffmpeg(videoPath)
                .outputOptions([
                    '-filter_complex', filterComplex,
                    '-c:v', 'libx264',
                    '-preset', 'fast',
                    '-crf', '23',
                    '-c:a', 'copy'
                ])
                .on('start', (cmd) => {
                    console.log('🎬 FFmpeg command:', cmd);
                })
                .on('stderr', (line) => {
                    // Only log errors
                    if (line.includes('Error') || line.includes('Invalid') || line.includes('Cannot find')) {
                        console.error('⚠️ FFmpeg:', line);
                    }
                })
                .on('error', (err) => {
                    console.error('❌ FFmpeg error:', err.message);
                    reject(err);
                })
                .on('end', () => {
                    console.log('✅ Video processing complete with overlay and branding');
                    resolve();
                })
                .save(outputPath);

        } catch (err) {
            console.error('❌ Error in addMemeText:', err);
            reject(err);
        }
    });
}

// Helper function to escape text for FFmpeg
function escapeTextSimple(text) {
    if (!text) return '';
    text = text.replace(/\\/g, '\\\\');
    text = text.replace(/'/g, "'\\\\''");
    text = text.replace(/:/g, '\\:');
    return text;
}

async function mixVideo(videoPath, dialoguePath, musicPath, outputPath) {
    return new Promise(async (resolve, reject) => {
        try {
            console.log('🎵 Starting audio mix...');
            const cmd = ffmpeg(videoPath);

            // Both dialogue and music - replace video audio with new audio
            if (dialoguePath && musicPath) {
                console.log('🎙️  Mixing dialogue + music (replacing original audio)');
                const musicDuration = await getAudioDuration(musicPath);
                const fadeInDuration = 2.5;
                const fadeOutDuration = 2.5;
                const fadeOutStart = musicDuration - fadeOutDuration;

                cmd.input(dialoguePath);
                cmd.input(musicPath);

                const complexFilter = [
                    "[1:a]volume=1.0[dialogue]",
                    `[2:a]afade=t=in:st=0:d=${fadeInDuration},afade=t=out:st=${fadeOutStart}:d=${fadeOutDuration},volume=0.85[music]`,
                    "[dialogue][music]amix=inputs=2:duration=longest[aout]"
                ];

                cmd.complexFilter(complexFilter)
                    .outputOptions([
                        "-map 0:v",      // Map video from input 0
                        "-map [aout]",   // Map mixed audio (ignoring original video audio)
                        "-c:v copy",
                        "-c:a aac",
                        "-shortest"
                    ]);
            }
            // Dialogue only - replace video audio with dialogue
            else if (dialoguePath && !musicPath) {
                console.log('🎙️  Adding dialogue only (replacing original audio)');
                cmd.input(dialoguePath);
                cmd.outputOptions([
                    "-map 0:v",      // Map video from input 0
                    "-map 1:a",      // Map audio from input 1 (dialogue) - ignoring original
                    "-c:v copy",
                    "-c:a aac"
                ]);
            }
            // Music only - replace video audio with music
            else if (!dialoguePath && musicPath) {
                console.log('🎵 Replacing original audio with music');
                const musicDuration = await getAudioDuration(musicPath);
                const fadeInDuration = 2.5;
                const fadeOutDuration = 2.5;
                const fadeOutStart = musicDuration - fadeOutDuration;

                cmd.input(musicPath);

                const complexFilter = [
                    `[1:a]afade=t=in:st=0:d=${fadeInDuration},afade=t=out:st=${fadeOutStart}:d=${fadeOutDuration},volume=0.85[aout]`
                ];

                cmd.complexFilter(complexFilter)
                    .outputOptions([
                        "-map 0:v",      // Map video from input 0
                        "-map [aout]",   // Map processed music (ignoring original video audio)
                        "-c:v copy",
                        "-c:a aac",
                        "-shortest"
                    ]);
            }
            // No new audio - keep original video audio
            else {
                console.log('📦 No new audio - keeping original video audio');
                cmd.outputOptions([
                    "-c:v copy",
                    "-c:a copy"
                ]);
            }

            cmd.save(outputPath)
                .on("start", (cmd) => {
                    console.log('🎬 Audio mix command:', cmd);
                })
                .on("end", () => {
                    console.log('✅ Audio processing complete');
                    resolve();
                })
                .on("error", (err) => {
                    console.error('❌ Audio processing error:', err);
                    reject(err);
                });
        } catch (err) {
            reject(err);
        }
    });
}

// ==================== API ENDPOINTS ====================

app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/api/combine", async (req, res) => {
    const startTime = Date.now();
    console.log('\n========================================');
    console.log('🚀 NEW REQUEST RECEIVED');
    console.log('========================================');
    
    try {
        await ensureDirectories();
        
        const {
            final_stitched_video,
            final_dialogue,
            final_music_url,
            response_modality,
            meme_top_text,
            meme_bottom_text,
            meme_project_name
        } = req.body;

        // Log received parameters
        console.log('📋 Request Parameters:');
        console.log('   Video URL:', final_stitched_video ? '✓' : '✗');
        console.log('   Dialogue URL:', final_dialogue ? '✓' : '✗');
        console.log('   Music URL:', final_music_url ? '✓' : '✗');
        console.log('   Response Modality:', response_modality);
        console.log('   Meme Top Text:', meme_top_text);
        console.log('   Meme Bottom Text:', meme_bottom_text);
        console.log('   Project Name:', meme_project_name);

        // Validate video URL
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

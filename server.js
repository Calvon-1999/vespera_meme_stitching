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
 * Split text into multiple lines based on character width
 * @param {string} text - Text to split
 * @param {number} maxChars - Maximum characters per line
 * @returns {string[]} Array of text lines
 */
function splitTextIntoLines(text, maxChars = 45) {
    if (!text || text.length <= maxChars) {
        return [text];
    }

    const words = text.split(' ');
    const lines = [];
    let currentLine = '';

    for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        
        if (testLine.length <= maxChars) {
            currentLine = testLine;
        } else {
            if (currentLine) {
                lines.push(currentLine);
            }
            currentLine = word;
        }
    }

    if (currentLine) {
        lines.push(currentLine);
    }

    return lines.length > 0 ? lines : [text];
}

/**
 * FIXED: Properly escape text for FFmpeg drawtext filter
 * This handles apostrophes, quotes, and special characters correctly
 */
function escapeFFmpegText(text) {
    if (!text) return '';
    
    return text
        .replace(/\\/g, '\\\\\\\\')     // Escape backslashes
        .replace(/'/g, "'\\\\\\\\''")   // Escape single quotes - THIS IS THE KEY FIX
        .replace(/:/g, '\\:')            // Escape colons (FFmpeg special char)
        .replace(/\[/g, '\\[')           // Escape brackets
        .replace(/\]/g, '\\]')
        .replace(/,/g, '\\,')            // Escape commas
        .replace(/\n/g, ' ')             // Replace newlines with spaces
        .trim();
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

            // Use the new splitTextIntoLines function
            const topLines = topText ? splitTextIntoLines(topText, 45) : [];
            const bottomLines = bottomText ? splitTextIntoLines(bottomText, 45) : [];
            
            console.log(`📝 Top text split into ${topLines.length} lines`);
            console.log(`📝 Bottom text split into ${bottomLines.length} lines`);

            // Calculate font sizing
            const maxLines = needsMemeText ? Math.max(topLines.length, bottomLines.length, 1) : 1;
            const baseDivisor = 12;
            const verticalCompressionFactor = 2;
            const dynamicDivisor = baseDivisor + ((maxLines - 1) * verticalCompressionFactor);
            
            const fontSize = Math.floor(height / dynamicDivisor);
            const strokeWidth = Math.max(2, Math.floor(fontSize / 10));
            const lineHeight = fontSize + 5;

            console.log(`🔤 Font size: ${fontSize}, Stroke: ${strokeWidth}, Line height: ${lineHeight}`);

            const escapedFontPath = CUSTOM_FONT_PATH.replace(/:/g, '\\:');

            if (!fs.existsSync(CUSTOM_FONT_PATH)) {
                console.warn(`⚠️  Warning: Font file not found at ${CUSTOM_FONT_PATH}`);
            }

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
            
            // Position overlay (full frame)
            const overlayX = 0;
            const overlayY = 0;
            console.log(`📍 Overlay position: x=${overlayX}, y=${overlayY} (full frame overlay)`);
            
            // Calculate estimated black bar height from overlay
            const estimatedBlackBarHeight = 100;
            const bottomTextBaseY = height - estimatedBlackBarHeight - 20;
            console.log(`📊 Bottom text will be positioned above black bar (estimated bar height: ${estimatedBlackBarHeight}px)`);

            // Build filter complex string
            const filterParts = [];
            
            // Add overlay image
            filterParts.push(`movie=${OVERLAY_IMAGE_PATH}[ovr]`);
            filterParts.push(`[0:v][ovr]overlay=${overlayX}:${overlayY}[base]`);

            let currentLabel = 'base';
            let labelIndex = 1;

            // Add top text lines
            if (topLines.length > 0) {
                let yPosition = 20; // Start from top
                
                topLines.forEach((line, i) => {
                    const escapedLine = escapeFFmpegText(line);
                    const nextLabel = `txt${labelIndex++}`;
                    
                    const drawTextFilter = `[${currentLabel}]drawtext=fontfile='${escapedFontPath}':fontcolor=white:fontsize=${fontSize}:bordercolor=black:borderw=${strokeWidth}:shadowcolor=black@0.5:shadowx=2:shadowy=2:text='${escapedLine}':x=(w-text_w)/2:y=${yPosition}[${nextLabel}]`;
                    
                    filterParts.push(drawTextFilter);
                    currentLabel = nextLabel;
                    yPosition += lineHeight;
                    
                    console.log(`   Top line ${i + 1}: "${line}"`);
                });
            }

            // Add bottom text lines
            if (bottomLines.length > 0) {
                // Calculate starting Y position for bottom text
                const totalBottomHeight = bottomLines.length * lineHeight;
                let yPosition = bottomTextBaseY - totalBottomHeight + lineHeight;
                
                bottomLines.forEach((line, i) => {
                    const escapedLine = escapeFFmpegText(line);
                    const nextLabel = `txt${labelIndex++}`;
                    
                    const drawTextFilter = `[${currentLabel}]drawtext=fontfile='${escapedFontPath}':fontcolor=white:fontsize=${fontSize}:bordercolor=black:borderw=${strokeWidth}:shadowcolor=black@0.5:shadowx=2:shadowy=2:text='${escapedLine}':x=(w-text_w)/2:y=${yPosition}[${nextLabel}]`;
                    
                    filterParts.push(drawTextFilter);
                    currentLabel = nextLabel;
                    yPosition += lineHeight;
                    
                    console.log(`   Bottom line ${i + 1}: "${line}"`);
                });
            }

            // Add branding (luna.fun)
            const brandingText = 'luna.fun';
            const brandingFontSize = 18;
            const brandingX = 20;
            const brandingY = height - 38; // 38px from bottom
            
            const escapedBranding = escapeFFmpegText(brandingText);
            const brandingFilter = `[${currentLabel}]drawtext=fontfile='${escapedFontPath}':fontcolor=white:fontsize=${brandingFontSize}:bordercolor=black:borderw=1:shadowcolor=black@0.5:shadowx=2:shadowy=2:text='${escapedBranding}':x=${brandingX}:y=${brandingY}`;
            filterParts.push(brandingFilter);

            const filterComplex = filterParts.join(';');

            console.log('🎬 Filter complex string:');
            console.log(filterComplex);
            console.log(`📊 Branding "${brandingText}" at bottom-left: x=${brandingX}, y=${brandingY}`);

            // Build FFmpeg command string for logging
            const ffmpegCommandStr = `ffmpeg -i ${videoPath} -y -filter_complex ${filterComplex} -c:v libx264 -preset fast -crf 23 -c:a copy ${outputPath}`;
            console.log('🎬 FFmpeg command:', ffmpegCommandStr);

            ffmpeg(videoPath)
                .outputOptions([
                    '-y',
                    '-filter_complex', filterComplex,
                    '-c:v', 'libx264',
                    '-preset', 'fast',
                    '-crf', '23',
                    '-c:a', 'copy'
                ])
                .output(outputPath)
                .on('start', (commandLine) => {
                    console.log('🚀 FFmpeg process started');
                })
                .on('progress', (progress) => {
                    if (progress.percent) {
                        console.log(`⏳ Processing: ${progress.percent.toFixed(1)}%`);
                    }
                })
                .on('end', () => {
                    console.log('✅ Meme text overlay complete');
                    resolve(outputPath);
                })
                .on('error', (err, stdout, stderr) => {
                    console.error('❌ FFmpeg error:', err.message);
                    if (stderr) {
                        console.error('⚠️ FFmpeg stderr:', stderr);
                    }
                    reject(err);
                })
                .run();

        } catch (err) {
            console.error('❌ Error in addMemeText:', err.message);
            reject(err);
        }
    });
}

async function mixVideo(videoPath, dialoguePath, musicPath, outputPath) {
    return new Promise(async (resolve, reject) => {
        try {
            console.log('🎵 Starting audio mix...');
            
            const hasDialogue = dialoguePath && fs.existsSync(dialoguePath);
            const hasMusic = musicPath && fs.existsSync(musicPath);

            if (!hasDialogue && !hasMusic) {
                console.log('⚠️  No audio files provided, copying video as-is');
                await fsp.copyFile(videoPath, outputPath);
                return resolve(outputPath);
            }

            const videoDuration = await getAudioDuration(videoPath);

            if (hasDialogue && hasMusic) {
                console.log('🎵 Mixing dialogue + music');
                const dialogueDuration = await getAudioDuration(dialoguePath);
                const musicDuration = await getAudioDuration(musicPath);

                const fadeOutStart = Math.max(0, dialogueDuration - 2.5);
                const musicFadeOutStart = Math.max(0, videoDuration - 2.5);

                const filterComplex = `
                    [1:a]afade=t=in:st=0:d=2.5,afade=t=out:st=${fadeOutStart}:d=2.5,volume=1.0[dialogue];
                    [2:a]afade=t=in:st=0:d=2.5,afade=t=out:st=${musicFadeOutStart}:d=2.5,volume=0.85[music];
                    [dialogue][music]amix=inputs=2:duration=first:dropout_transition=2[aout]
                `.replace(/\s+/g, ' ').trim();

                console.log('🎬 Audio mix command:', `ffmpeg -i ${videoPath} -i ${dialoguePath} -i ${musicPath} -y -filter_complex ${filterComplex} -map 0:v -map [aout] -c:v copy -c:a aac -shortest ${outputPath}`);

                ffmpeg(videoPath)
                    .input(dialoguePath)
                    .input(musicPath)
                    .outputOptions([
                        '-y',
                        '-filter_complex', filterComplex,
                        '-map', '0:v',
                        '-map', '[aout]',
                        '-c:v', 'copy',
                        '-c:a', 'aac',
                        '-shortest'
                    ])
                    .output(outputPath)
                    .on('end', () => {
                        console.log('✅ Audio processing complete');
                        resolve(outputPath);
                    })
                    .on('error', reject)
                    .run();

            } else if (hasDialogue) {
                console.log('🎵 Adding dialogue only');
                const dialogueDuration = await getAudioDuration(dialoguePath);
                const fadeOutStart = Math.max(0, dialogueDuration - 2.5);

                const filterComplex = `[1:a]afade=t=in:st=0:d=2.5,afade=t=out:st=${fadeOutStart}:d=2.5,volume=1.0[aout]`;

                console.log('🎬 Audio mix command:', `ffmpeg -i ${videoPath} -i ${dialoguePath} -y -filter_complex ${filterComplex} -map 0:v -map [aout] -c:v copy -c:a aac -shortest ${outputPath}`);

                ffmpeg(videoPath)
                    .input(dialoguePath)
                    .outputOptions([
                        '-y',
                        '-filter_complex', filterComplex,
                        '-map', '0:v',
                        '-map', '[aout]',
                        '-c:v', 'copy',
                        '-c:a', 'aac',
                        '-shortest'
                    ])
                    .output(outputPath)
                    .on('end', () => {
                        console.log('✅ Audio processing complete');
                        resolve(outputPath);
                    })
                    .on('error', reject)
                    .run();

            } else if (hasMusic) {
                console.log('🎵 Replacing original audio with music');
                const musicDuration = await getAudioDuration(musicPath);
                const fadeOutStart = Math.max(0, videoDuration - 2.5);

                const filterComplex = `[1:a]afade=t=in:st=0:d=2.5,afade=t=out:st=${fadeOutStart}:d=2.5,volume=0.85[aout]`;

                console.log('🎬 Audio mix command:', `ffmpeg -i ${videoPath} -i ${musicPath} -y -filter_complex ${filterComplex} -map 0:v -map [aout] -c:v copy -c:a aac -shortest ${outputPath}`);

                ffmpeg(videoPath)
                    .input(musicPath)
                    .outputOptions([
                        '-y',
                        '-filter_complex', filterComplex,
                        '-map', '0:v',
                        '-map', '[aout]',
                        '-c:v', 'copy',
                        '-c:a', 'aac',
                        '-shortest'
                    ])
                    .output(outputPath)
                    .on('end', () => {
                        console.log('✅ Audio processing complete');
                        resolve(outputPath);
                    })
                    .on('error', reject)
                    .run();
            }

        } catch (err) {
            reject(err);
        }
    });
}

// ==================== MAIN ENDPOINT ====================

app.post("/api/process", async (req, res) => {
    const startTime = Date.now();
    
    try {
        await ensureDirectories();

        const {
            final_stitched_video,
            final_dialogue = null,
            final_music_url = null,
            response_modality = "video",
            meme_top_text = "",
            meme_bottom_text = "",
            meme_project_name = ""
        } = req.body;

        console.log('\n========================================');
        console.log('🚀 NEW REQUEST RECEIVED');
        console.log('========================================');
        console.log('📋 Request Parameters:');
        console.log('   Video URL:', final_stitched_video ? '✓' : '✗');
        console.log('   Dialogue URL:', final_dialogue ? '✓' : '✗');
        console.log('   Music URL:', final_music_url ? '✓' : '✗');
        console.log('   Response Modality:', response_modality);
        console.log('   Meme Top Text:', meme_top_text);
        console.log('   Meme Bottom Text:', meme_bottom_text);
        console.log('   Project Name:', meme_project_name);
        console.log('========================================');

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

// Health check endpoint
app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

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

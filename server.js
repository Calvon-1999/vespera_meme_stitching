const express = require("express");
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const { v4: uuidv4 } = require("uuid");

// FFmpeg Setup
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Custom Font Configuration
const CUSTOM_FONT_PATH = path.join(__dirname, "public", "fonts", "Montserrat-Bold.ttf");

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
 * Uses placeholder to protect newlines during escaping
 */
function escapeForDrawtext(text) {
    if (!text) return '';
    
    const NEWLINE_PLACEHOLDER = 'FFMPEG_NEWLINE_PLACEHOLDER_42';
    
    // Step 1: Protect newlines with placeholder
    text = text.replace(/\n/g, NEWLINE_PLACEHOLDER);
    
    // Step 2: Escape FFmpeg special characters (order matters!)
    text = text.replace(/\\/g, '\\\\\\\\');  // Backslashes first
    text = text.replace(/'/g, '\\\'');        // Single quotes
    text = text.replace(/:/g, '\\:');         // Colons
    
    // Step 3: Convert placeholder to FFmpeg newline format with proper escaping
    // For centered multi-line text, we need literal \n in the filter
    text = text.replace(new RegExp(NEWLINE_PLACEHOLDER, 'g'), '\\n');
    
    return text;
}

/**
 * Adds meme text overlay to video
 */
async function addMemeText(videoPath, outputPath, topText = "", bottomText = "") {
    return new Promise(async (resolve, reject) => {
        try {
            console.log('🎨 addMemeText function called');
            console.log('   Video path:', videoPath);
            console.log('   Output path:', outputPath);
            console.log('   Top text:', topText);
            console.log('   Bottom text:', bottomText);

            // If no text, just copy the file
            if (!topText && !bottomText) {
                console.log('⚠️  No text provided - copying video file');
                await fsp.copyFile(videoPath, outputPath);
                resolve();
                return;
            }

            // Get video dimensions
            const { width, height } = await getVideoDimensions(videoPath);
            console.log(`📐 Video dimensions: ${width}x${height}`);

            // Wrap text for multi-line display
            const wrappedTopText = wrapText(topText, 30);
            const wrappedBottomText = wrapText(bottomText, 30);
            
            console.log('📝 Wrapped top text:', wrappedTopText);
            console.log('📝 Wrapped bottom text:', wrappedBottomText);

            // Calculate font size based on number of lines
            const topLines = wrappedTopText.split('\n').length;
            const bottomLines = wrappedBottomText.split('\n').length;
            const maxLines = Math.max(topLines, bottomLines, 1);
            
            const baseDivisor = 13;
            const verticalCompressionFactor = 2;
            const dynamicDivisor = baseDivisor + ((maxLines - 1) * verticalCompressionFactor);
            
            const fontSize = Math.floor(height / dynamicDivisor);
            const strokeWidth = Math.max(2, Math.floor(fontSize / 10));
            const verticalOffset = 20;

            console.log(`🔤 Font size: ${fontSize}, Stroke: ${strokeWidth}`);

            // Escape font path for FFmpeg
            const escapedFontPath = CUSTOM_FONT_PATH.replace(/:/g, '\\:');

            // Check if font exists
            if (!fs.existsSync(CUSTOM_FONT_PATH)) {
                console.warn(`⚠️  Warning: Font file not found at ${CUSTOM_FONT_PATH}`);
            }

            // Shared drawtext parameters
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

            // Build filter chain
            let filterChain = '';
            let currentStream = '[0:v]';

            // Top text filter
            if (topText) {
                const escapedTopText = escapeForDrawtext(wrappedTopText);
                console.log('🔐 Escaped top text:', escapedTopText);
                
                const topFilter = `drawtext=${drawtextParams}:text='${escapedTopText}':x=(w-text_w)/2:y=${verticalOffset}`;
                
                if (bottomText) {
                    filterChain += `${currentStream}${topFilter}[v_temp];`;
                    currentStream = '[v_temp]';
                } else {
                    filterChain += `${currentStream}${topFilter}[v_out]`;
                }
            }

            // Bottom text filter
            if (bottomText) {
                const escapedBottomText = escapeForDrawtext(wrappedBottomText);
                console.log('🔐 Escaped bottom text:', escapedBottomText);
                
                const bottomFilter = `drawtext=${drawtextParams}:text='${escapedBottomText}':x=(w-text_w)/2:y=h-text_h-${verticalOffset}`;
                
                filterChain += `${currentStream}${bottomFilter}[v_out]`;
            }

            console.log('🎬 FFmpeg filter chain:', filterChain);

            // Execute FFmpeg
            ffmpeg()
                .input(videoPath)
                .complexFilter(filterChain, 'v_out')
                .videoCodec('libx264')
                .outputOptions(['-preset', 'fast', '-crf', '23'])
                .audioCodec('copy')
                .on('start', (cmd) => {
                    console.log('🎬 FFmpeg command:', cmd);
                })
                .on('stderr', (line) => {
                    if (line.includes('error') || line.includes('Error')) {
                        console.error('FFmpeg stderr:', line);
                    }
                })
                .on('end', () => {
                    console.log('✅ Meme text overlay complete');
                    resolve();
                })
                .on('error', (err) => {
                    console.error('❌ FFmpeg error:', err.message);
                    reject(err);
                })
                .save(outputPath);

        } catch (err) {
            console.error('❌ Error in addMemeText:', err);
            reject(err);
        }
    });
}

/**
 * Mixes video with dialogue and/or music
 */
async function mixVideo(videoPath, dialoguePath, musicPath, outputPath) {
    return new Promise(async (resolve, reject) => {
        try {
            console.log('🎵 Starting audio mix...');
            const cmd = ffmpeg(videoPath);

            // Both dialogue and music
            if (dialoguePath && musicPath) {
                console.log('🎙️  Mixing dialogue + music');
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
                        "-map 0:v",
                        "-map [aout]",
                        "-c:v copy",
                        "-c:a aac",
                        "-shortest"
                    ]);
            }
            // Dialogue only
            else if (dialoguePath && !musicPath) {
                console.log('🎙️  Mixing dialogue only');
                cmd.input(dialoguePath);
                cmd.outputOptions([
                    "-map 0:v",
                    "-map 1:a",
                    "-c:v copy",
                    "-c:a aac"
                ]);
            }
            // Music only
            else if (!dialoguePath && musicPath) {
                console.log('🎵 Mixing music only');
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
                        "-map 0:v",
                        "-map [aout]",
                        "-c:v copy",
                        "-c:a aac",
                        "-shortest"
                    ]);
            }
            // No audio (shouldn't reach here, but handle it)
            else {
                console.log('📦 No audio - copying video');
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
                    console.log('✅ Audio mix complete');
                    resolve();
                })
                .on("error", (err) => {
                    console.error('❌ Audio mix error:', err);
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
            meme_bottom_text
        } = req.body;

        // Log received parameters
        console.log('📋 Request Parameters:');
        console.log('   Video URL:', final_stitched_video ? '✓' : '✗');
        console.log('   Dialogue URL:', final_dialogue ? '✓' : '✗');
        console.log('   Music URL:', final_music_url ? '✓' : '✗');
        console.log('   Response Modality:', response_modality);
        console.log('   Meme Top Text:', meme_top_text);
        console.log('   Meme Bottom Text:', meme_bottom_text);

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
        const outputPath = path.join(OUTPUT_DIR, `${id}_final.mp4`);

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

        // Process video with meme text if needed
        let videoToMix = videoPath;
        if (needsMemeText) {
            console.log('\n🎨 Adding meme text overlay...');
            await addMemeText(videoPath, videoWithTextPath, meme_top_text, meme_bottom_text);
            videoToMix = videoWithTextPath;
        } else {
            console.log('\n⏭️  Skipping meme text (none provided)');
        }

        // Mix audio if provided
        if (final_dialogue || final_music_url) {
            console.log('\n🎵 Mixing audio with video...');
            await mixVideo(videoToMix, dialoguePath, musicPath, outputPath);
        } else {
            console.log('\n📦 No audio to mix - copying video...');
            await fsp.copyFile(videoToMix, outputPath);
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

        res.json({
            success: true,
            message: needsMemeText 
                ? "Video created with meme text overlay" 
                : "Video created successfully",
            download_url: `/download/${path.basename(outputPath)}`,
            processing_time: `${duration}s`,
            job_id: id
        });

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

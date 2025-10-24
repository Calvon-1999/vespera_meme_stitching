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

// Font Configuration - Multilingual Support
const FONTS = {
    english: path.join(__dirname, "public", "fonts", "Montserrat-Bold.ttf"),
    chinese: path.join(__dirname, "public", "fonts", "ZCOOLKuaiLe-Regular.ttf"),
    japanese: path.join(__dirname, "public", "fonts", "RampartOne-Regular.ttf"),
    korean: path.join(__dirname, "public", "fonts", "Jua-Regular.ttf")
};

// Overlay Image Configuration
const OVERLAY_IMAGE_PATH = path.join(__dirname, "image", "blackbarLucien.png");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: "50mb" }));

const TEMP_DIR = "/tmp";
const OUTPUT_DIR = path.join(TEMP_DIR, "output");

// ==================== UTILITY FUNCTIONS ====================

/**
 * Detects the primary language of the input text
 * Returns: 'english', 'chinese', 'japanese', or 'korean'
 */
function detectLanguage(text) {
    if (!text) return 'english';
    
    // Count characters by language
    let chineseCount = 0;
    let japaneseCount = 0;
    let koreanCount = 0;
    let totalCJKCount = 0;
    
    for (const char of text) {
        const code = char.charCodeAt(0);
        
        // Chinese characters (CJK Unified Ideographs)
        if ((code >= 0x4E00 && code <= 0x9FFF) || // Common Chinese
            (code >= 0x3400 && code <= 0x4DBF) || // Extension A
            (code >= 0x20000 && code <= 0x2A6DF)) { // Extension B
            chineseCount++;
            totalCJKCount++;
        }
        // Japanese-specific characters
        else if ((code >= 0x3040 && code <= 0x309F) || // Hiragana
                 (code >= 0x30A0 && code <= 0x30FF)) { // Katakana
            japaneseCount++;
            totalCJKCount++;
        }
        // Korean characters (Hangul)
        else if ((code >= 0xAC00 && code <= 0xD7AF) || // Hangul Syllables
                 (code >= 0x1100 && code <= 0x11FF) || // Hangul Jamo
                 (code >= 0x3130 && code <= 0x318F)) { // Hangul Compatibility Jamo
            koreanCount++;
            totalCJKCount++;
        }
    }
    
    // If less than 10% CJK characters, assume English
    if (totalCJKCount < text.length * 0.1) {
        return 'english';
    }
    
    // Determine which CJK language is dominant
    if (koreanCount > chineseCount && koreanCount > japaneseCount) {
        return 'korean';
    } else if (japaneseCount > chineseCount) {
        return 'japanese';
    } else if (chineseCount > 0) {
        return 'chinese';
    }
    
    // Default to English
    return 'english';
}

/**
 * Gets the appropriate font path based on provided or detected language
 * @param {string} text - The text to get font for
 * @param {string} providedLanguage - Optional language override ('english', 'chinese', 'japanese', 'korean')
 */
function getFontForText(text, providedLanguage = null) {
    let language;
    
    if (providedLanguage && FONTS[providedLanguage.toLowerCase()]) {
        // Use provided language if valid
        language = providedLanguage.toLowerCase();
        console.log(`🔤 Using provided language: ${language} for text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
    } else {
        // Fall back to auto-detection
        language = detectLanguage(text);
        console.log(`🔤 Auto-detected language: ${language} for text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
    }
    
    const fontPath = FONTS[language];
    
    if (!fs.existsSync(fontPath)) {
        console.warn(`⚠️  Warning: Font file not found at ${fontPath}, falling back to English font`);
        return FONTS.english;
    }
    
    return fontPath;
}

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

async function addMemeText(videoPath, outputPath, topText = "", bottomText = "", projectName = "", memeLanguage = null) {
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

            // Detect language and get appropriate font for top and bottom text
            // Use provided language if available, otherwise auto-detect
            const topTextFont = topText ? getFontForText(topText, memeLanguage) : FONTS.english;
            const bottomTextFont = bottomText ? getFontForText(bottomText, memeLanguage) : FONTS.english;
            
            const escapedTopTextFont = topTextFont.replace(/:/g, '\\:');
            const escapedBottomTextFont = bottomTextFont.replace(/:/g, '\\:');

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
            
            // Calculate text position within the overlay (adjusting for overlay position)
            const brandingFontSize = 24;
            const brandingY = overlayY + 40; // Moved down by 30 pixels from original (10 -> 40)
            
            const escapedProjectName = escapeForDrawtext(projectName);
            console.log(`📝 Project name for branding: ${projectName}`);

            let filterComplex = `[0:v]movie='${OVERLAY_IMAGE_PATH.replace(/'/g, "'\\\\''").replace(/:/g, '\\:')}' [overlay]; [0:v][overlay]overlay=${overlayX}:${overlayY}`;

            // Only add meme text if provided
            if (needsMemeText) {
                // Add TOP text
                if (topText) {
                    const topTextFilters = topLines.map((line, index) => {
                        const escapedLine = escapeForDrawtext(line);
                        const yPos = verticalOffset + (index * lineHeight);
                        return `drawtext=fontfile='${escapedTopTextFont}':text='${escapedLine}':fontcolor=white:fontsize=${fontSize}:bordercolor=black:borderw=${strokeWidth}:shadowcolor=black@0.5:shadowx=2:shadowy=2:x=(w-text_w)/2:y=${yPos}`;
                    }).join(',');
                    filterComplex += `,${topTextFilters}`;
                }

                // Add BOTTOM text
                if (bottomText) {
                    const bottomTextFilters = bottomLines.map((line, index) => {
                        const escapedLine = escapeForDrawtext(line);
                        const yPos = height - verticalOffset - ((bottomLines.length - index) * lineHeight);
                        return `drawtext=fontfile='${escapedBottomTextFont}':text='${escapedLine}':fontcolor=white:fontsize=${fontSize}:bordercolor=black:borderw=${strokeWidth}:shadowcolor=black@0.5:shadowx=2:shadowy=2:x=(w-text_w)/2:y=${yPos}`;
                    }).join(',');
                    filterComplex += `,${bottomTextFilters}`;
                }
            }

            // Add project name/branding (always shown)
            if (projectName) {
                const escapedBrandingFont = FONTS.english.replace(/:/g, '\\:');
                filterComplex += `,drawtext=fontfile='${escapedBrandingFont}':text='${escapedProjectName}':fontcolor=white:fontsize=${brandingFontSize}:x=(w-text_w)/2:y=${brandingY}`;
            }

            console.log(`🎬 Filter complex: ${filterComplex.substring(0, 200)}...`);

            ffmpeg(videoPath)
                .complexFilter(filterComplex)
                .outputOptions([
                    '-c:v libx264',
                    '-preset fast',
                    '-crf 18',
                    '-c:a copy'
                ])
                .output(outputPath)
                .on('start', (cmd) => console.log('🚀 FFmpeg started:', cmd.substring(0, 300) + '...'))
                .on('progress', (progress) => {
                    if (progress.percent) {
                        console.log(`⏳ Progress: ${progress.percent.toFixed(1)}%`);
                    }
                })
                .on('end', () => {
                    console.log('✅ Meme text and branding added successfully');
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    console.error('❌ FFmpeg error:', err.message);
                    reject(err);
                })
                .run();

        } catch (err) {
            console.error('❌ Error in addMemeText:', err);
            reject(err);
        }
    });
}

async function mixVideo(videoPath, audioPath, musicPath, outputPath) {
    return new Promise(async (resolve, reject) => {
        try {
            console.log('🎵 mixVideo function called');
            
            const hasAudio = !!audioPath;
            const hasMusic = !!musicPath;

            if (!hasAudio && !hasMusic) {
                console.log('⚠️  No audio or music provided - copying video as-is');
                await fsp.copyFile(videoPath, outputPath);
                return resolve(outputPath);
            }

            const videoDuration = await getVideoDimensions(videoPath).then(() => 
                new Promise((res, rej) => {
                    ffmpeg.ffprobe(videoPath, (err, metadata) => {
                        if (err) rej(err);
                        else res(metadata.format.duration);
                    });
                })
            );

            console.log(`📏 Video duration: ${videoDuration}s`);

            let inputs = [videoPath];
            let filterInputs = [];
            let filterComplex = '';
            let outputMap = '[outv]';

            if (hasAudio) {
                inputs.push(audioPath);
                filterInputs.push('[1:a]');
            }

            if (hasMusic) {
                inputs.push(musicPath);
                const musicIndex = hasAudio ? 2 : 1;
                filterInputs.push(`[${musicIndex}:a]`);
            }

            if (filterInputs.length > 0) {
                const audioFilters = filterInputs.map((input, idx) => {
                    if (idx === filterInputs.length - 1 && hasMusic) {
                        return `${input}volume=0.3`;
                    }
                    return input;
                }).join('');

                filterComplex = `${audioFilters}amerge=inputs=${filterInputs.length}[outa]`;
                outputMap = '[outv];[outa]';
            }

            console.log(`🎬 Filter complex: ${filterComplex}`);

            const command = ffmpeg();
            
            inputs.forEach(input => command.input(input));

            if (filterComplex) {
                command.complexFilter(filterComplex);
            }

            command
                .outputOptions([
                    '-map', '0:v',
                    ...(filterComplex ? ['-map', '[outa]'] : ['-map', '0:a?']),
                    '-c:v', 'copy',
                    '-c:a', 'aac',
                    '-b:a', '192k',
                    '-shortest'
                ])
                .output(outputPath)
                .on('start', (cmd) => console.log('🚀 FFmpeg mixing started:', cmd.substring(0, 300) + '...'))
                .on('progress', (progress) => {
                    if (progress.percent) {
                        console.log(`⏳ Mixing progress: ${progress.percent.toFixed(1)}%`);
                    }
                })
                .on('end', () => {
                    console.log('✅ Video mixed successfully');
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    console.error('❌ FFmpeg mixing error:', err.message);
                    reject(err);
                })
                .run();

        } catch (err) {
            console.error('❌ Error in mixVideo:', err);
            reject(err);
        }
    });
}

// ==================== API ENDPOINTS ====================

app.get("/health", (req, res) => {
    res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Main processing function (used by both endpoints)
async function processVideoRequest(req, res) {
    const startTime = Date.now();
    console.log('\n========================================');
    console.log('🎬 NEW VIDEO PROCESSING REQUEST');
    console.log('========================================');

    try {
        await ensureDirectories();

        const {
            final_stitched_video,
            final_dialogue,
            final_music_url,
            meme_top_text,
            meme_bottom_text,
            meme_project_name,
            meme_language
        } = req.body;

        console.log('📋 Request parameters:');
        console.log('   Video URL:', final_stitched_video ? '✅' : '❌');
        console.log('   Audio URL:', final_dialogue ? '✅' : '❌');
        console.log('   Music URL:', final_music_url ? '✅' : '❌');
        console.log('   Top text:', meme_top_text || '(none)');
        console.log('   Bottom text:', meme_bottom_text || '(none)');
        console.log('   Project name:', meme_project_name || '(none)');
        console.log('   Language:', meme_language || '(auto-detect)');

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
        await addMemeText(videoPath, videoWithTextPath, meme_top_text, meme_bottom_text, meme_project_name, meme_language);
        
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
}

// Endpoint routes - both point to the same handler
app.post("/process-video", processVideoRequest);
app.post("/api/combine", processVideoRequest); // Backward compatibility alias

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
    console.log(`🎨 Fonts configured:`);
    console.log(`   - English: ${FONTS.english}`);
    console.log(`   - Chinese: ${FONTS.chinese}`);
    console.log(`   - Japanese: ${FONTS.japanese}`);
    console.log(`   - Korean: ${FONTS.korean}`);
    console.log('========================================\n');
});

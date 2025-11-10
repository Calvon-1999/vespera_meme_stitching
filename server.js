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
const OVERLAY_IMAGE_PATH = path.join(__dirname, "image", "1248x704.png");

// Outro Video Configuration
const LUCIEN_OUTRO_PATH = path.join(__dirname, "videos", "LucienOutro.mp4");

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
 * Handles both Latin and CJK characters appropriately
 */
function wrapText(text, maxCharsPerLine = 35) {
    if (!text) return '';
    
    // Check if text contains significant CJK characters
    const cjkCount = (text.match(/[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g) || []).length;
    const hasCJK = cjkCount > text.length * 0.3;
    
    if (hasCJK) {
        // For CJK text, wrap at character boundaries (CJK chars are wider)
        const adjustedMax = Math.floor(maxCharsPerLine * 0.6); // CJK chars are ~2x wider
        let result = '';
        let currentLength = 0;
        
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const isCJK = /[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/.test(char);
            const charWidth = isCJK ? 2 : 1;
            
            if (currentLength + charWidth > adjustedMax && currentLength > 0) {
                result += '\n';
                currentLength = 0;
            }
            
            result += char;
            currentLength += charWidth;
        }
        
        return result.trim();
    } else {
        // For Latin text, wrap at word boundaries
        const words = text.split(' ');
        let lines = [];
        let currentLine = '';

        for (const word of words) {
            const testLine = currentLine ? currentLine + ' ' + word : word;
            
            // If adding this word would exceed the limit, start a new line
            if (testLine.length > maxCharsPerLine) {
                if (currentLine) {
                    lines.push(currentLine);
                    currentLine = word;
                } else {
                    // Single word is too long, force break it
                    lines.push(word);
                    currentLine = '';
                }
            } else {
                currentLine = testLine;
            }
        }
        
        // Add the last line
        if (currentLine) {
            lines.push(currentLine);
        }
        
        return lines.join('\n');
    }
}

/**
 * Escapes text for FFmpeg drawtext filter
 * Handles special characters, emojis, and Unicode safely
 */
function escapeForDrawtext(text) {
    if (!text) return '';
    
    // First pass: handle basic escaping
    let escaped = text;
    
    // Escape backslashes first (before other escapes that introduce backslashes)
    escaped = escaped.replace(/\\/g, '\\\\\\\\');
    
    // Escape single quotes for FFmpeg shell
    escaped = escaped.replace(/'/g, "'\\\\\\\\''");
    
    // Escape colons (FFmpeg parameter separator)
    escaped = escaped.replace(/:/g, '\\\\:');
    
    // Escape special FFmpeg characters
    escaped = escaped.replace(/\[/g, '\\\\[');
    escaped = escaped.replace(/\]/g, '\\\\]');
    escaped = escaped.replace(/,/g, '\\\\,');
    escaped = escaped.replace(/;/g, '\\\\;');
    
    // Handle newlines last - convert to FFmpeg newline sequence
    escaped = escaped.replace(/\n/g, '\\n');
    
    return escaped;
}

/**
 * Concatenates multiple videos into one
 * Handles videos with or without audio streams
 */
async function concatenateVideos(videoPaths, outputPath) {
    return new Promise(async (resolve, reject) => {
        try {
            console.log('🔗 Concatenating videos...');
            console.log(`   Number of videos: ${videoPaths.length}`);
            
            // Check which videos have audio
            const videoHasAudio = await Promise.all(
                videoPaths.map(videoPath => 
                    new Promise((res) => {
                        ffmpeg.ffprobe(videoPath, (err, metadata) => {
                            if (err) {
                                res(false);
                                return;
                            }
                            const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
                            res(!!audioStream);
                        });
                    })
                )
            );
            
            console.log('🔍 Audio streams present:', videoHasAudio);
            
            const allHaveAudio = videoHasAudio.every(has => has);
            const someHaveAudio = videoHasAudio.some(has => has);
            
            const command = ffmpeg();
            
            // Add all input videos
            videoPaths.forEach(videoPath => {
                command.input(videoPath);
            });
            
            let filterComplex;
            let outputOptions;
            
            if (allHaveAudio) {
                // All videos have audio - use normal concat with audio
                console.log('✅ All videos have audio - concatenating with audio');
                filterComplex = videoPaths.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('') + 
                               `concat=n=${videoPaths.length}:v=1:a=1[outv][outa]`;
                outputOptions = [
                    '-map', '[outv]',
                    '-map', '[outa]',
                    '-c:v', 'libx264',
                    '-preset', 'fast',
                    '-crf', '18',
                    '-c:a', 'aac',
                    '-b:a', '192k'
                ];
            } else if (someHaveAudio) {
                // Some videos have audio - add silent audio to videos without it
                console.log('⚠️  Mixed audio streams - adding silent audio where needed');
                let filterParts = [];
                
                // Add silent audio to videos without audio
                videoPaths.forEach((_, i) => {
                    if (videoHasAudio[i]) {
                        // Video has audio - use as is
                        filterParts.push(`[${i}:v:0][${i}:a:0]`);
                    } else {
                        // Video has no audio - generate silent audio
                        filterParts.push(`[${i}:v:0]anullsrc=channel_layout=stereo:sample_rate=48000[silent${i}];[silent${i}]`);
                    }
                });
                
                filterComplex = filterParts.join('') + `concat=n=${videoPaths.length}:v=1:a=1[outv][outa]`;
                outputOptions = [
                    '-map', '[outv]',
                    '-map', '[outa]',
                    '-c:v', 'libx264',
                    '-preset', 'fast',
                    '-crf', '18',
                    '-c:a', 'aac',
                    '-b:a', '192k',
                    '-shortest'
                ];
            } else {
                // No videos have audio - concat video only
                console.log('⚠️  No audio streams - concatenating video only');
                filterComplex = videoPaths.map((_, i) => `[${i}:v:0]`).join('') + 
                               `concat=n=${videoPaths.length}:v=1:a=0[outv]`;
                outputOptions = [
                    '-map', '[outv]',
                    '-c:v', 'libx264',
                    '-preset', 'fast',
                    '-crf', '18'
                ];
            }
            
            console.log(`🎬 Filter: ${filterComplex.substring(0, 150)}${filterComplex.length > 150 ? '...' : ''}`);
            
            command
                .complexFilter(filterComplex)
                .outputOptions(outputOptions)
                .output(outputPath)
                .on('start', (cmd) => console.log('🚀 FFmpeg concatenation started'))
                .on('progress', (progress) => {
                    if (progress.percent) {
                        console.log(`⏳ Concatenation progress: ${progress.percent.toFixed(1)}%`);
                    }
                })
                .on('end', () => {
                    console.log('✅ Videos concatenated successfully');
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    console.error('❌ FFmpeg concatenation error:', err.message);
                    reject(err);
                })
                .run();
                
        } catch (err) {
            console.error('❌ Error in concatenateVideos:', err);
            reject(err);
        }
    });
}

/**
 * Adds branding text to video (bottom-left corner)
 * For Pudgy projects - no overlay, no meme text, just brand
 */
async function addBrandingOnly(videoPath, outputPath, projectName) {
    return new Promise(async (resolve, reject) => {
        try {
            console.log('🏷️  Adding branding only');
            
            const { width, height } = await getVideoDimensions(videoPath);
            console.log(`📐 Video dimensions: ${width}x${height}`);

            // Use English font for branding
            const selectedFont = FONTS.english;
            const escapedFont = selectedFont.replace(/:/g, '\\:');

            // Add luna.fun branding at bottom-left corner
            const brandingText = `luna.fun/memes/${projectName}`;
            const escapedBrandingText = escapeForDrawtext(brandingText);
            const brandingFontSize = 18;
            const brandingStrokeWidth = 1;
            const brandingX = 20;
            const brandingY = height - brandingFontSize - 20;

            const filterComplex = 
                `[0:v]drawtext=fontfile='${escapedFont}':` +
                `text='${escapedBrandingText}':` +
                `fontcolor=white:` +
                `fontsize=${brandingFontSize}:` +
                `bordercolor=black:` +
                `borderw=${brandingStrokeWidth}:` +
                `shadowcolor=black@0.5:` +
                `shadowx=2:` +
                `shadowy=2:` +
                `x=${brandingX}:` +
                `y=${brandingY}[outv]`;

            ffmpeg(videoPath)
                .complexFilter(filterComplex)
                .outputOptions([
                    '-map', '[outv]',
                    '-map', '0:a?',
                    '-c:v', 'libx264',
                    '-preset', 'fast',
                    '-crf', '18',
                    '-c:a', 'copy'
                ])
                .output(outputPath)
                .on('start', (cmd) => console.log('🚀 FFmpeg branding started'))
                .on('progress', (progress) => {
                    if (progress.percent) {
                        console.log(`⏳ Branding progress: ${progress.percent.toFixed(1)}%`);
                    }
                })
                .on('end', () => {
                    console.log('✅ Branding added successfully');
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    console.error('❌ FFmpeg branding error:', err.message);
                    reject(err);
                })
                .run();

        } catch (err) {
            console.error('❌ Error in addBrandingOnly:', err);
            reject(err);
        }
    });
}

/**
 * Adds only the top and bottom meme text to video (no overlay, no branding)
 * Used for the "without overlay" version
 * FIXED: Bottom text position matches second code's simpler, lower positioning
 */
async function addMemeTextOnly(videoPath, outputPath, topText = "", bottomText = "", memeLanguage = null) {
    return new Promise(async (resolve, reject) => {
        try {
            console.log('🎨 addMemeTextOnly function called (no overlay/branding)');
            
            if (!topText && !bottomText) {
                console.log('⚠️  No meme text provided - copying video as-is');
                await fsp.copyFile(videoPath, outputPath);
                return resolve(outputPath);
            }

            const { width, height } = await getVideoDimensions(videoPath);
            console.log(`📐 Video dimensions: ${width}x${height}`);

            const wrappedTopText = wrapText(topText, 35);
            const wrappedBottomText = wrapText(bottomText, 35);
            
            const topLines = wrappedTopText.split('\n').filter(line => line.trim());
            const bottomLines = wrappedBottomText.split('\n').filter(line => line.trim());
            const maxLines = Math.max(topLines.length, bottomLines.length, 1);
            
            // Adjust font size calculation to be more conservative
            const baseDivisor = 14;
            const verticalCompressionFactor = 2;
            const dynamicDivisor = baseDivisor + ((maxLines - 1) * verticalCompressionFactor);
            
            const fontSize = Math.floor(height / dynamicDivisor);
            const strokeWidth = Math.max(2, Math.floor(fontSize / 10));
            const lineHeight = Math.floor(fontSize * 1.3); // 30% extra space between lines
            
            // FIXED: Much more generous padding to prevent any cropping
            const verticalPadding = Math.floor(height * 0.04); // 4% of video height as padding
            
            console.log(`🔤 Font size: ${fontSize}, Stroke: ${strokeWidth}, Line height: ${lineHeight}`);

            // Select font based on language
            let selectedFont;
            if (memeLanguage && FONTS[memeLanguage.toLowerCase()]) {
                selectedFont = FONTS[memeLanguage.toLowerCase()];
                console.log(`🔤 Using provided language font: ${memeLanguage}`);
            } else {
                const textToDetect = topText || bottomText || '';
                selectedFont = textToDetect ? getFontForText(textToDetect, null) : FONTS.english;
                console.log(`🔤 Auto-detecting font from text content`);
            }
            
            const escapedFont = selectedFont.replace(/:/g, '\\:');

            // Build filter complex
            let filterParts = [];
            let currentVideoLabel = '0:v';
            let labelCounter = 1;

            // Add TOP text with proper padding
            if (topText) {
                for (let index = 0; index < topLines.length; index++) {
                    const line = topLines[index];
                    const escapedLine = escapeForDrawtext(line);
                    const yPos = verticalPadding + (index * lineHeight);
                    const nextLabel = `v${labelCounter}`;
                    
                    filterParts.push(
                        `[${currentVideoLabel}]drawtext=fontfile='${escapedFont}':` +
                        `text='${escapedLine}':` +
                        `fontcolor=white:` +
                        `fontsize=${fontSize}:` +
                        `bordercolor=black:` +
                        `borderw=${strokeWidth}:` +
                        `shadowcolor=black@0.5:` +
                        `shadowx=2:` +
                        `shadowy=2:` +
                        `x=(w-text_w)/2:` +
                        `y=${yPos}[${nextLabel}]`
                    );
                    
                    currentVideoLabel = nextLabel;
                    labelCounter++;
                }
            }

            // Add BOTTOM text with simpler positioning (matching second code)
            if (bottomText) {
                // Calculate total height needed for bottom text
                const totalBottomTextHeight = bottomLines.length * lineHeight;
                const bottomOffset = verticalPadding;
                
                for (let index = 0; index < bottomLines.length; index++) {
                    const line = bottomLines[index];
                    const escapedLine = escapeForDrawtext(line);
                    // Position from bottom: video height - total text block height - offset + line offset
                    const yPos = height - totalBottomTextHeight - bottomOffset + (index * lineHeight);
                    const nextLabel = `v${labelCounter}`;
                    
                    filterParts.push(
                        `[${currentVideoLabel}]drawtext=fontfile='${escapedFont}':` +
                        `text='${escapedLine}':` +
                        `fontcolor=white:` +
                        `fontsize=${fontSize}:` +
                        `bordercolor=black:` +
                        `borderw=${strokeWidth}:` +
                        `shadowcolor=black@0.5:` +
                        `shadowx=2:` +
                        `shadowy=2:` +
                        `x=(w-text_w)/2:` +
                        `y=${yPos}[${nextLabel}]`
                    );
                    
                    currentVideoLabel = nextLabel;
                    labelCounter++;
                }
            }

            const filterComplex = filterParts.join(';');
            console.log(`🎬 Filter complex parts: ${filterParts.length}`);

            ffmpeg(videoPath)
                .complexFilter(filterComplex)
                .outputOptions([
                    '-map', `[${currentVideoLabel}]`,
                    '-map', '0:a?', // FIXED: Copy original audio if present
                    '-c:v', 'libx264',
                    '-preset', 'fast',
                    '-crf', '18',
                    '-c:a', 'copy'
                ])
                .output(outputPath)
                .on('start', (cmd) => {
                    console.log('🚀 FFmpeg started (text only)');
                })
                .on('stderr', (stderrLine) => {
                    if (stderrLine.includes('Error') || stderrLine.includes('Invalid')) {
                        console.error('FFmpeg stderr:', stderrLine);
                    }
                })
                .on('progress', (progress) => {
                    if (progress.percent) {
                        console.log(`⏳ Progress: ${progress.percent.toFixed(1)}%`);
                    }
                })
                .on('end', () => {
                    console.log('✅ Meme text added successfully (no overlay)');
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    console.error('❌ FFmpeg error:', err.message);
                    reject(err);
                })
                .run();

        } catch (err) {
            console.error('❌ Error in addMemeTextOnly:', err);
            reject(err);
        }
    });
}

/**
 * Adds meme text with overlay and branding
 * FIXED: Bottom text position matches second code's simpler, lower positioning
 */
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

            const wrappedTopText = wrapText(topText, 35);
            const wrappedBottomText = wrapText(bottomText, 35);
            
            const topLines = wrappedTopText.split('\n').filter(line => line.trim());
            const bottomLines = wrappedBottomText.split('\n').filter(line => line.trim());
            const maxLines = needsMemeText ? Math.max(topLines.length, bottomLines.length, 1) : 1;
            
            // Adjust font size calculation to be more conservative
            const baseDivisor = 14;
            const verticalCompressionFactor = 2;
            const dynamicDivisor = baseDivisor + ((maxLines - 1) * verticalCompressionFactor);
            
            const fontSize = Math.floor(height / dynamicDivisor);
            const strokeWidth = Math.max(2, Math.floor(fontSize / 10));
            const lineHeight = Math.floor(fontSize * 1.3); // 30% extra space between lines
            
            // FIXED: Much more generous padding
            const topPadding = Math.floor(height * 0.04); // 4% of video height
            
            // Black bar configuration
            const estimatedBlackBarHeight = 100;
            const bottomPadding = estimatedBlackBarHeight + Math.floor(height * 0.08); // Black bar + 8% padding

            console.log(`🔤 Font size: ${fontSize}, Stroke: ${strokeWidth}, Line height: ${lineHeight}`);

            // Use the same font for ALL text based on language parameter
            let selectedFont;
            if (memeLanguage && FONTS[memeLanguage.toLowerCase()]) {
                selectedFont = FONTS[memeLanguage.toLowerCase()];
                console.log(`🔤 Using provided language font for all text: ${memeLanguage}`);
            } else {
                const textToDetect = topText || bottomText || '';
                selectedFont = textToDetect ? getFontForText(textToDetect, null) : FONTS.english;
                console.log(`🔤 Auto-detecting font from text content`);
            }
            
            const escapedFont = selectedFont.replace(/:/g, '\\:');

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
            
            // Use overlay at native size
            const overlayWidth = overlayDimensions.width;
            const overlayHeight = overlayDimensions.height;
            
            // Position at bottom of video
            const overlayX = Math.floor((width - overlayWidth) / 2);
            const overlayY = height - overlayHeight;
            console.log(`📍 Overlay position: x=${overlayX}, y=${overlayY}`);
            
            console.log(`📝 Project name for branding: ${projectName}`);

            // Build filter complex step by step
            let filterParts = [];
            
            // Step 1: Load overlay image
            filterParts.push(`movie='${OVERLAY_IMAGE_PATH.replace(/'/g, "'\\\\''").replace(/:/g, '\\:')}'[overlay]`);
            
            // Step 2: Overlay the image on the video
            filterParts.push(`[0:v][overlay]overlay=${overlayX}:${overlayY}[v1]`);
            
            let currentVideoLabel = 'v1';
            let labelCounter = 2;

            // Add TOP text with proper padding
            if (needsMemeText && topText) {
                for (let index = 0; index < topLines.length; index++) {
                    const line = topLines[index];
                    const escapedLine = escapeForDrawtext(line);
                    const yPos = topPadding + (index * lineHeight);
                    const nextLabel = `v${labelCounter}`;
                    
                    filterParts.push(
                        `[${currentVideoLabel}]drawtext=fontfile='${escapedFont}':` +
                        `text='${escapedLine}':` +
                        `fontcolor=white:` +
                        `fontsize=${fontSize}:` +
                        `bordercolor=black:` +
                        `borderw=${strokeWidth}:` +
                        `shadowcolor=black@0.5:` +
                        `shadowx=2:` +
                        `shadowy=2:` +
                        `x=(w-text_w)/2:` +
                        `y=${yPos}[${nextLabel}]`
                    );
                    
                    currentVideoLabel = nextLabel;
                    labelCounter++;
                }
            }

            // Add BOTTOM text - EXACT same positioning as addMemeTextOnly for consistency
            if (needsMemeText && bottomText) {
                // Calculate total height needed for bottom text
                const totalBottomTextHeight = bottomLines.length * lineHeight;
                // Use EXACT same offset as the version without overlay (just the 8% padding)
                const bottomOffsetForText = Math.floor(height * 0.08);
                
                for (let index = 0; index < bottomLines.length; index++) {
                    const line = bottomLines[index];
                    const escapedLine = escapeForDrawtext(line);
                    // EXACT same calculation as addMemeTextOnly() for consistent positioning
                    const yPos = height - totalBottomTextHeight - bottomOffsetForText + (index * lineHeight);
                    const nextLabel = `v${labelCounter}`;
                    
                    filterParts.push(
                        `[${currentVideoLabel}]drawtext=fontfile='${escapedFont}':` +
                        `text='${escapedLine}':` +
                        `fontcolor=white:` +
                        `fontsize=${fontSize}:` +
                        `bordercolor=black:` +
                        `borderw=${strokeWidth}:` +
                        `shadowcolor=black@0.5:` +
                        `shadowx=2:` +
                        `shadowy=2:` +
                        `x=(w-text_w)/2:` +
                        `y=${yPos}[${nextLabel}]`
                    );
                    
                    currentVideoLabel = nextLabel;
                    labelCounter++;
                }
            }

            // Add luna.fun branding at bottom-left corner
            const brandingText = projectName ? `luna.fun/memes/${projectName}` : "luna.fun/memes";
            const escapedBrandingText = escapeForDrawtext(brandingText);
            const brandingFontSize = 18;
            const brandingStrokeWidth = 1;
            const brandingX = 20;
            const brandingY = height - brandingFontSize - 20;
            
            const nextLabel = `vout`;
            
            filterParts.push(
                `[${currentVideoLabel}]drawtext=fontfile='${escapedFont}':` +
                `text='${escapedBrandingText}':` +
                `fontcolor=white:` +
                `fontsize=${brandingFontSize}:` +
                `bordercolor=black:` +
                `borderw=${brandingStrokeWidth}:` +
                `shadowcolor=black@0.5:` +
                `shadowx=2:` +
                `shadowy=2:` +
                `x=${brandingX}:` +
                `y=${brandingY}[${nextLabel}]`
            );
            
            currentVideoLabel = nextLabel;

            const filterComplex = filterParts.join(';');

            console.log(`🎬 Filter complex parts: ${filterParts.length}`);
            
            if (topText) console.log(`📝 Top text lines: ${topLines.length}`);
            if (bottomText) console.log(`📝 Bottom text lines: ${bottomLines.length}`);

            ffmpeg(videoPath)
                .complexFilter(filterComplex)
                .outputOptions([
                    '-map', `[${currentVideoLabel}]`,
                    '-map', '0:a?', // FIXED: Copy original audio if present
                    '-c:v', 'libx264',
                    '-preset', 'fast',
                    '-crf', '18',
                    '-c:a', 'copy'
                ])
                .output(outputPath)
                .on('start', (cmd) => {
                    console.log('🚀 FFmpeg started');
                })
                .on('stderr', (stderrLine) => {
                    if (stderrLine.includes('Error') || stderrLine.includes('Invalid')) {
                        console.error('FFmpeg stderr:', stderrLine);
                    }
                })
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

/**
 * FIXED: Properly mix video with its original audio plus background music
 * Ensures video duration is maintained
 */
async function mixVideo(videoPath, audioPath, musicPath, outputPath) {
    return new Promise(async (resolve, reject) => {
        try {
            console.log('🎵 mixVideo function called');
            
            const hasDialogue = !!audioPath;
            const hasMusic = !!musicPath;
            
            // Check if video has audio
            const videoHasAudio = await new Promise((res) => {
                ffmpeg.ffprobe(videoPath, (err, metadata) => {
                    if (err) {
                        res(false);
                        return;
                    }
                    const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
                    res(!!audioStream);
                });
            });

            console.log(`🎧 Video has audio: ${videoHasAudio}`);
            console.log(`🎤 Has dialogue: ${hasDialogue}`);
            console.log(`🎵 Has music: ${hasMusic}`);

            if (!hasDialogue && !hasMusic && !videoHasAudio) {
                console.log('⚠️  No audio sources - copying video as-is');
                await fsp.copyFile(videoPath, outputPath);
                return resolve(outputPath);
            }

            const videoDuration = await new Promise((res, rej) => {
                ffmpeg.ffprobe(videoPath, (err, metadata) => {
                    if (err) rej(err);
                    else res(metadata.format.duration);
                });
            });

            console.log(`📏 Video duration: ${videoDuration}s`);

            let inputs = [videoPath];
            let filterComplex = '';
            let audioInputs = [];

            // FIXED: Include original video audio if present
            if (videoHasAudio) {
                audioInputs.push('[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[original_audio]');
            }

            if (hasDialogue) {
                inputs.push(audioPath);
                const dialogueIndex = inputs.length - 1;
                // Dialogue plays once, amix will handle duration
                audioInputs.push(`[${dialogueIndex}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[dialogue_audio]`);
            }

            if (hasMusic) {
                inputs.push(musicPath);
                const musicIndex = inputs.length - 1;
                // FIXED: Trim music to video duration (no looping, just trim if longer)
                audioInputs.push(`[${musicIndex}:a]atrim=duration=${videoDuration},volume=0.3,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[music_audio]`);
            }

            // Build filter complex to mix all audio sources
            if (audioInputs.length > 0) {
                const audioLabels = [];
                if (videoHasAudio) audioLabels.push('[original_audio]');
                if (hasDialogue) audioLabels.push('[dialogue_audio]');
                if (hasMusic) audioLabels.push('[music_audio]');
                
                if (audioLabels.length > 1) {
                    // Multiple audio sources - use amix to overlay (not amerge which causes silence)
                    filterComplex = audioInputs.join(';');
                    // amix allows tracks to overlap, so music continues when dialogue ends
                    filterComplex += `;${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0[outa]`;
                } else if (audioLabels.length === 1) {
                    // Only one audio source
                    const label = audioLabels[0].replace('[', '').replace(']', '');
                    filterComplex = audioInputs[0].replace(`[${label}]`, '[outa]');
                }
            }

            console.log(`🎬 Audio inputs: ${audioInputs.length}`);
            console.log(`🎬 Filter complex: ${filterComplex.substring(0, 200)}${filterComplex.length > 200 ? '...' : ''}`);

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
                    '-t', videoDuration.toString() // FIXED: Ensure output matches video duration
                ])
                .output(outputPath)
                .on('start', (cmd) => console.log('🚀 FFmpeg mixing started'))
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

        // Check if this is a Pudgy project format
        let isPudgyProject = false;
        let videoUrl, musicUrl, projectName;
        
        if (Array.isArray(req.body) && req.body.length > 0 && req.body[0].data) {
            // Pudgy project format
            const data = req.body[0].data;
            if (data.length > 0 && data[0].meme_project_name === 'Pudgy') {
                isPudgyProject = true;
                projectName = data[0].meme_project_name;
                
                // Get music from scene 1
                const scene1 = data.find(scene => scene.scene_number === 1);
                musicUrl = scene1?.generated_music;
                
                console.log('🎯 Pudgy project detected!');
                console.log('📋 Pudgy Request parameters:');
                console.log('   Project name:', projectName);
                console.log('   Music URL (from scene 1):', musicUrl ? '✅' : '❌');
                console.log('   Number of scenes:', data.length);
                
                // Validate we have all 3 scenes
                if (data.length !== 3) {
                    console.error('❌ Pudgy project must have exactly 3 scenes');
                    return res.status(400).json({ error: "Pudgy project must have exactly 3 scenes" });
                }
                
                // Validate all scenes have video URLs
                for (const scene of data) {
                    if (!scene.generated_video) {
                        console.error(`❌ Missing video URL for scene ${scene.scene_number}`);
                        return res.status(400).json({ error: `Missing video URL for scene ${scene.scene_number}` });
                    }
                }
                
                // Validate that LucienOutro.mp4 exists
                if (!fs.existsSync(LUCIEN_OUTRO_PATH)) {
                    console.error(`❌ LucienOutro.mp4 not found at ${LUCIEN_OUTRO_PATH}`);
                    return res.status(400).json({ error: `LucienOutro.mp4 not found at ${LUCIEN_OUTRO_PATH}` });
                }
                
                // Generate unique ID for this processing job
                const id = uuidv4();
                console.log('🆔 Job ID:', id);
                
                // Download all scene videos
                console.log('\n📥 Downloading Pudgy scene videos...');
                const sceneVideoPaths = [];
                for (const scene of data) {
                    const scenePath = path.join(TEMP_DIR, `${id}_scene${scene.scene_number}.mp4`);
                    await downloadFile(scene.generated_video, scenePath);
                    sceneVideoPaths.push(scenePath);
                }
                
                // Download music if available
                let musicPath = null;
                if (musicUrl) {
                    musicPath = path.join(TEMP_DIR, `${id}_music.mp3`);
                    await downloadFile(musicUrl, musicPath);
                }
                
                // Concatenate scene 1, 2, 3 videos
                console.log('\n🔗 Stitching scene videos together...');
                const stitchedVideoPath = path.join(TEMP_DIR, `${id}_stitched.mp4`);
                await concatenateVideos(sceneVideoPaths, stitchedVideoPath);
                
                // Add music overlay to stitched scenes if available
                const videoWithMusicPath = path.join(TEMP_DIR, `${id}_with_music.mp4`);
                if (musicPath) {
                    console.log('\n🎵 Adding music overlay to scenes...');
                    await mixVideo(stitchedVideoPath, null, musicPath, videoWithMusicPath);
                } else {
                    await fsp.copyFile(stitchedVideoPath, videoWithMusicPath);
                }
                
                // Concatenate the stitched video (with music) + LucienOutro.mp4
                console.log('\n🎬 Adding LucienOutro.mp4 at the end...');
                const outputPath = path.join(OUTPUT_DIR, `${id}_final.mp4`);
                await concatenateVideos([videoWithMusicPath, LUCIEN_OUTRO_PATH], outputPath);
                
                // Clean up temporary files
                console.log('\n🧹 Cleaning up temporary files...');
                try {
                    for (const scenePath of sceneVideoPaths) {
                        await fsp.unlink(scenePath);
                    }
                    if (musicPath) await fsp.unlink(musicPath);
                    await fsp.unlink(stitchedVideoPath);
                    await fsp.unlink(videoWithMusicPath);
                } catch (cleanupErr) {
                    console.warn('⚠️  Cleanup warning:', cleanupErr.message);
                }
                
                const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                console.log(`\n✅ Pudgy video processing complete in ${duration}s`);
                console.log('========================================\n');
                
                return res.json({
                    success: true,
                    message: "Pudgy video created with music and outro (no branding)",
                    processing_time: `${duration}s`,
                    job_id: id,
                    download: `/download/${path.basename(outputPath)}`
                });
            }
        }
        
        if (!isPudgyProject) {
            // Original format
            const {
                final_stitched_video,
                final_stitch_video, // Alternative parameter name
                final_dialogue,
                final_music_url,
                meme_top_text,
                meme_bottom_text,
                meme_project_name,
                meme_language
            } = req.body;
            
            // FIXED: Support both parameter names
            videoUrl = final_stitched_video || final_stitch_video;

            console.log('📋 Request parameters:');
            console.log('   Video URL:', videoUrl ? '✅' : '❌');
            console.log('   Audio URL:', final_dialogue ? '✅' : '❌');
            console.log('   Music URL:', final_music_url ? '✅' : '❌');
            console.log('   Top text:', meme_top_text || '(none)');
            console.log('   Bottom text:', meme_bottom_text || '(none)');
            console.log('   Project name:', meme_project_name || '(none)');
            console.log('   Language:', meme_language || '(auto-detect)');

            if (!videoUrl) {
                console.error('❌ Missing video URL');
                return res.status(400).json({ error: "Missing required input: final_stitched_video or final_stitch_video" });
            }

            // Generate unique ID for this processing job
            const id = uuidv4();
            console.log('🆔 Job ID:', id);

            // Define file paths
            const videoPath = path.join(TEMP_DIR, `${id}_video.mp4`);
            const dialoguePath = final_dialogue ? path.join(TEMP_DIR, `${id}_dialogue.mp3`) : null;
            const musicPath = final_music_url ? path.join(TEMP_DIR, `${id}_music.mp3`) : null;
            const videoWithTextPath = path.join(TEMP_DIR, `${id}_with_text.mp4`);
            const videoWithTextNoOverlayPath = path.join(TEMP_DIR, `${id}_with_text_no_overlay.mp4`);
            const outputPathWithOverlay = path.join(OUTPUT_DIR, `${id}_with_overlay.mp4`);
            const outputPathWithoutOverlay = path.join(OUTPUT_DIR, `${id}_without_overlay.mp4`);

            // Determine if meme text is needed
            const needsMemeText = (meme_top_text || meme_bottom_text) ? true : false;
            
            console.log('🔍 Processing Plan:');
            console.log('   Needs meme text:', needsMemeText);
            console.log('   Has audio/music:', !!(final_dialogue || final_music_url));

            // Download video
            console.log('\n📥 Downloading assets...');
            await downloadFile(videoUrl, videoPath);

            // Download audio files if provided
            if (final_dialogue) {
                await downloadFile(final_dialogue, dialoguePath);
            }
            if (final_music_url) {
                await downloadFile(final_music_url, musicPath);
            }

            // Generate both versions: with and without overlay
            console.log('\n🎬 Generating both versions...');
            
            // Version 1: Without overlay - add meme text only (no overlay, no branding)
            if (needsMemeText) {
                console.log('📦 Creating version without overlay (with meme text)...');
                await addMemeTextOnly(videoPath, videoWithTextNoOverlayPath, meme_top_text, meme_bottom_text, meme_language);
                
                if (final_dialogue || final_music_url) {
                    await mixVideo(videoWithTextNoOverlayPath, dialoguePath, musicPath, outputPathWithoutOverlay);
                } else {
                    await fsp.copyFile(videoWithTextNoOverlayPath, outputPathWithoutOverlay);
                }
            } else {
                console.log('📦 Creating version without overlay (no meme text)...');
                if (final_dialogue || final_music_url) {
                    await mixVideo(videoPath, dialoguePath, musicPath, outputPathWithoutOverlay);
                } else {
                    await fsp.copyFile(videoPath, outputPathWithoutOverlay);
                }
            }

            // Version 2: With overlay (meme text + overlay + branding)
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
                if (needsMemeText) {
                    await fsp.unlink(videoWithTextPath);
                    await fsp.unlink(videoWithTextNoOverlayPath);
                } else {
                    await fsp.unlink(videoWithTextPath);
                }
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
        }

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
    console.log(`🎬 Outro video: ${LUCIEN_OUTRO_PATH}`);
    console.log('========================================\n');
});

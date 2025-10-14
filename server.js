const express = require("express");
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);

// FFmpeg Setup
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// --- 🔑 CUSTOM FONT CONFIGURATION ---
// Absolute path inside the container: /app/public/fonts/Montserrat-Bold.ttf
const CUSTOM_FONT_PATH = path.join(__dirname, "public", "fonts", "Montserrat-Bold.ttf");
// ------------------------------------

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: "50mb" }));

const TEMP_DIR = "/tmp";
const OUTPUT_DIR = path.join(TEMP_DIR, "output");

// --- Utility Functions ---

async function ensureDirectories() {
    await fsp.mkdir(OUTPUT_DIR, { recursive: true });
}

async function downloadFile(url, filepath) {
    const response = await axios({ method: "GET", url, responseType: "stream" });
    const writer = fs.createWriteStream(filepath);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on("finish", resolve);
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
                resolve({
                    width: videoStream.width,
                    height: videoStream.height
                });
            }
        });
    });
}

/**
 * Helper to escape text for FFmpeg's drawtext filter. 
 * This is the most critical part for stability.
 */
const escapeForDrawtext = (text) => {
    // 1. Escape single quotes first, as they enclose the text value in the filter string
    text = text.replace(/'/g, '\\\'');
    // 2. Escape colons, which are used as parameter separators
    text = text.replace(/:/g, '\\:');
    // 3. Escape backslashes, they are escape characters
    text = text.replace(/\\/g, '\\\\\\\\'); 
    return text;
};


async function addMemeText(videoPath, outputPath, topText = "", bottomText = "") {
    return new Promise(async (resolve, reject) => {
        try {
            if (!topText && !bottomText) {
                await fsp.copyFile(videoPath, outputPath);
                resolve();
                return;
            }

            console.log(`📝 Adding meme text - Top: "${topText}", Bottom: "${bottomText}"`);

            const { height } = await getVideoDimensions(videoPath);
            
            // Text Calculation Constants
            const fontSize = Math.floor(height / 14);
            const strokeWidth = Math.max(1, Math.floor(fontSize / 20)); 
            const verticalOffset = 20; 

            // FFmpeg requires the font path to be escaped for colons (just in case)
            const escapedFontPath = CUSTOM_FONT_PATH.replace(/:/g, '\\:');

            // Shared parameters for the drawtext filter
            const drawtextParams = [
                `fontfile='${escapedFontPath}'`,
                `fontcolor=white`,
                `fontsize=${fontSize}`,
                `bordercolor=black`,
                `borderw=${strokeWidth}`,
                `shadowcolor=black@0.5`,
                `shadowx=1`,
                `shadowy=1`,
                `enable='between(t,0,999)'`,
            ].join(':');

            const filters = [];
            
            // --- Top Text Filter ---
            if (topText) {
                const escapedTopText = escapeForDrawtext(topText);
                const topFilter = `drawtext=${drawtextParams}:text='${escapedTopText}':x=(w-text_w)/2:y=${verticalOffset}`;
                
                // If bottom text also exists, output to [v_temp] for chaining.
                // If only top text exists, output to the final stream [v_out].
                const outputLabel = bottomText ? '[v_temp]' : '[v_out]';
                filters.push(`[0:v]${topFilter}${outputLabel}`);
            }

            // --- Bottom Text Filter ---
            if (bottomText) {
                const escapedBottomText = escapeForDrawtext(bottomText);
                const bottomFilter = `drawtext=${drawtextParams}:text='${escapedBottomText}':x=(w-text_w)/2:y=h-text_h-${verticalOffset}`;

                // Input label is [v_temp] if top text exists, or the original stream [0:v] otherwise.
                const inputLabel = topText ? '[v_temp]' : '[0:v]';
                
                // Output is always the final stream [v_out]
                filters.push(`${inputLabel}${bottomFilter}[v_out]`);
            }
            
            if (filters.length === 0) {
                 return reject(new Error("Text input was provided but no filter was generated."));
            }
            
            console.log('🎬 FFmpeg filter array:', filters.join(';'));

            // --- Execute FFmpeg with drawtext filter ---
            ffmpeg()
                .input(videoPath)
                // Use the filter array for robust chaining
                .complexFilter(filters) 
                .videoCodec('libx264') 
                .outputOptions(['-preset', 'fast', '-crf', '23'])
                .audioCodec('copy')
                .on('start', (cmd) => {
                    console.log('🎬 FFmpeg command:', cmd);
                })
                .on('stderr', (line) => {
                    console.log('FFmpeg output:', line);
                })
                .on('end', () => {
                    console.log('✅ Meme text overlay complete');
                    resolve();
                })
                .on('error', (err) => {
                    console.error('❌ FFmpeg drawtext error:', err.message);
                    reject(err);
                })
                .save(outputPath);

        } catch (err) {
            console.error('❌ Error in addMemeText:', err);
            reject(err);
        }
    });
}

async function mixVideo(videoPath, dialoguePath, musicPath, outputPath) {
    return new Promise(async (resolve, reject) => {
        try {
            const cmd = ffmpeg(videoPath);

            if (dialoguePath && musicPath) {
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
            else if (dialoguePath && !musicPath) {
                cmd.input(dialoguePath);

                cmd.outputOptions([
                    "-map 0:v",
                    "-map 1:a",
                    "-c:v copy",
                    "-c:a aac"
                ]);
            }
            else if (!dialoguePath && musicPath) {
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
            else {
                cmd.outputOptions([
                    "-c:v copy",
                    "-c:a copy"
                ]);
            }

            cmd.save(outputPath)
                .on("end", () => resolve())
                .on("error", (err) => reject(err));
        } catch (err) {
            reject(err);
        }
    });
}

// --- API Endpoints ---

app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

app.post("/api/combine", async (req, res) => {
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

        if (!final_stitched_video) {
            return res.status(400).json({ error: "Missing required input: video" });
        }

        if (!final_dialogue && !final_music_url) {
            return res.status(400).json({ error: "At least one audio source (dialogue or music) is required" });
        }

        const id = uuidv4();
        const videoPath = path.join(TEMP_DIR, `${id}_video.mp4`);
        const dialoguePath = final_dialogue ? path.join(TEMP_DIR, `${id}_dialogue.mp3`) : null;
        const musicPath = final_music_url ? path.join(TEMP_DIR, `${id}_music.mp3`) : null;

        const needsMemeText = response_modality === "meme" && (meme_top_text || meme_bottom_text);
        const videoWithTextPath = needsMemeText ? path.join(TEMP_DIR, `${id}_with_text.mp4`) : null;
        const outputPath = path.join(OUTPUT_DIR, `${id}_final.mp4`);

        console.log('📥 Downloading video...');
        await downloadFile(final_stitched_video, videoPath);
        if (final_dialogue) {
            console.log('📥 Downloading dialogue...');
            await downloadFile(final_dialogue, dialoguePath);
        }
        if (final_music_url) {
            console.log('📥 Downloading music...');
            await downloadFile(final_music_url, musicPath);
        }

        let videoToMix = videoPath;
        if (needsMemeText) {
            console.log(`🎨 Adding meme text overlay...`);
            await addMemeText(videoPath, videoWithTextPath, meme_top_text, meme_bottom_text);
            videoToMix = videoWithTextPath;
        }

        console.log('🎵 Mixing video and audio...');
        await mixVideo(videoToMix, dialoguePath, musicPath, outputPath);

        console.log('✅ Processing complete!');

        res.json({
            message: needsMemeText
                ? "✅ Combined video created with meme text overlay"
                : "✅ Combined video created",
            download_url: `/download/${path.basename(outputPath)}`
        });
    } catch (err) {
        console.error("❌ Processing failed:", err);
        res.status(500).json({ error: "Processing failed", details: err.message });
    }
});

// Serve the combined videos
app.use("/download", express.static(OUTPUT_DIR));

app.listen(PORT, () =>
    console.log(`🚀 Server running on http://localhost:${PORT}`)
);

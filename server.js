const express = require("express");
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { createCanvas } = require("canvas");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);
const app = express();
const PORT = process.env.PORT || 8080;
app.use(express.json({ limit: "50mb" }));
const TEMP_DIR = "/tmp";
const OUTPUT_DIR = path.join(TEMP_DIR, "output");

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

function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = words[0];

  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const width = ctx.measureText(currentLine + ' ' + word).width;
    if (width < maxWidth) {
      currentLine += ' ' + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }
  lines.push(currentLine);
  return lines;
}

async function createTextOverlay(width, height, topText = "", bottomText = "", outputPath) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  
  // Transparent background
  ctx.clearRect(0, 0, width, height);
  
  // Calculate font size (roughly 1/15th of height)
  const fontSize = Math.floor(height / 15);
  
  // Configure text style - Impact-like bold font
  ctx.font = `bold ${fontSize}px Arial`;
  ctx.fillStyle = 'white';
  ctx.strokeStyle = 'black';
  ctx.lineWidth = Math.max(3, fontSize / 16);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  
  const centerX = width / 2;
  const margin = 30;
  const maxTextWidth = width - (margin * 2);
  
  // Draw top text
  if (topText) {
    const lines = wrapText(ctx, topText.toUpperCase(), maxTextWidth);
    lines.forEach((line, i) => {
      const y = margin + (i * fontSize * 1.2);
      ctx.strokeText(line, centerX, y);
      ctx.fillText(line, centerX, y);
    });
  }
  
  // Draw bottom text
  if (bottomText) {
    const lines = wrapText(ctx, bottomText.toUpperCase(), maxTextWidth);
    ctx.textBaseline = 'bottom';
    lines.reverse().forEach((line, i) => {
      const y = height - margin - (i * fontSize * 1.2);
      ctx.strokeText(line, centerX, y);
      ctx.fillText(line, centerX, y);
    });
  }
  
  // Save as PNG
  const buffer = canvas.toBuffer('image/png');
  await fsp.writeFile(outputPath, buffer);
}

async function addMemeText(videoPath, outputPath, topText = "", bottomText = "") {
  return new Promise(async (resolve, reject) => {
    try {
      // If no text, just copy the video
      if (!topText && !bottomText) {
        await fsp.copyFile(videoPath, outputPath);
        resolve();
        return;
      }
      
      const { width, height } = await getVideoDimensions(videoPath);
      const overlayPath = path.join(TEMP_DIR, `overlay_${uuidv4()}.png`);
      
      console.log(`📝 Creating text overlay: ${width}x${height}`);
      
      // Create text overlay image
      await createTextOverlay(width, height, topText, bottomText, overlayPath);
      
      console.log(`✅ Overlay created at: ${overlayPath}`);
      
      // Verify overlay file exists
      const overlayStats = await fsp.stat(overlayPath);
      console.log(`📊 Overlay file size: ${overlayStats.size} bytes`);
      
      // Overlay the image on video using FFmpeg - simpler approach
      const cmd = ffmpeg()
        .input(videoPath)
        .input(overlayPath)
        .videoCodec('libx264')
        .outputOptions([
          '-filter_complex', '[0:v][1:v]overlay=0:0',
          '-preset', 'fast',
          '-crf', '23'
        ])
        .audioCodec('copy')
        .on('start', (commandLine) => {
          console.log('🎬 FFmpeg command:', commandLine);
        })
        .on('stderr', (stderrLine) => {
          console.log('FFmpeg stderr:', stderrLine);
        })
        .on('end', async () => {
          console.log('✅ Text overlay complete');
          // Clean up overlay file
          try {
            await fsp.unlink(overlayPath);
          } catch (err) {
            console.warn('Could not delete overlay file:', err.message);
          }
          resolve();
        })
        .on('error', (err, stdout, stderr) => {
          console.error('❌ FFmpeg error:', err.message);
          console.error('FFmpeg stderr:', stderr);
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
      
      // Scenario 1: Video + Dialogue + Music
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
      // Scenario 2: Video + Dialogue only (no music)
      else if (dialoguePath && !musicPath) {
        cmd.input(dialoguePath);
        
        cmd.outputOptions([
          "-map 0:v",
          "-map 1:a",
          "-c:v copy",
          "-c:a aac"
        ]);
      }
      // Scenario 3: Video + Music only (no dialogue)
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
      // Scenario 4: Video only
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
    
    // Only video is required now
    if (!final_stitched_video) {
      return res.status(400).json({ error: "Missing required input: video" });
    }
    
    // At least one audio source should be provided
    if (!final_dialogue && !final_music_url) {
      return res.status(400).json({ error: "At least one audio source (dialogue or music) is required" });
    }
    
    const id = uuidv4();
    const videoPath = path.join(TEMP_DIR, `${id}_video.mp4`);
    const dialoguePath = final_dialogue ? path.join(TEMP_DIR, `${id}_dialogue.mp3`) : null;
    const musicPath = final_music_url ? path.join(TEMP_DIR, `${id}_music.mp3`) : null;
    
    // Determine if we need meme text overlay
    const needsMemeText = response_modality === "meme" && (meme_top_text || meme_bottom_text);
    const videoWithTextPath = needsMemeText ? path.join(TEMP_DIR, `${id}_with_text.mp4`) : null;
    const outputPath = path.join(OUTPUT_DIR, `${id}_final.mp4`);
    
    // Download files
    await downloadFile(final_stitched_video, videoPath);
    if (final_dialogue) {
      await downloadFile(final_dialogue, dialoguePath);
    }
    if (final_music_url) {
      await downloadFile(final_music_url, musicPath);
    }
    
    // Step 1: Add meme text if needed (only for response_modality: meme)
    let videoToMix = videoPath;
    if (needsMemeText) {
      console.log(`🎨 Adding meme text - Top: "${meme_top_text}", Bottom: "${meme_bottom_text}"`);
      await addMemeText(videoPath, videoWithTextPath, meme_top_text, meme_bottom_text);
      videoToMix = videoWithTextPath;
    }
    
    // Step 2: Mix video + audio
    await mixVideo(videoToMix, dialoguePath, musicPath, outputPath);
    
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

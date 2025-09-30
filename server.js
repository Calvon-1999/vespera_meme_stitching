const express = require("express");
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const { v4: uuidv4 } = require("uuid");
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

async function mixVideo(videoPath, dialoguePath, musicPath, outputPath) {
  return new Promise(async (resolve, reject) => {
    try {
      // Get music duration to calculate fade out timing
      const musicDuration = await getAudioDuration(musicPath);
      const fadeInDuration = 2.5; // 2.5 seconds fade in
      const fadeOutDuration = 2.5; // 2.5 seconds fade out
      const fadeOutStart = musicDuration - fadeOutDuration;
      
      const cmd = ffmpeg(videoPath);
      
      // Add inputs conditionally
      if (dialoguePath) {
        cmd.input(dialoguePath);
      }
      cmd.input(musicPath);
      
      // Build complex filter based on whether dialogue exists
      let complexFilter;
      if (dialoguePath) {
        complexFilter = [
          "[1:a]volume=1.0[dialogue]",
          `[2:a]afade=t=in:st=0:d=${fadeInDuration},afade=t=out:st=${fadeOutStart}:d=${fadeOutDuration},volume=0.85[music]`,
          "[dialogue][music]amix=inputs=2:duration=longest[aout]"
        ];
      } else {
        complexFilter = [
          `[1:a]afade=t=in:st=0:d=${fadeInDuration},afade=t=out:st=${fadeOutStart}:d=${fadeOutDuration},volume=0.85[aout]`
        ];
      }
      
      cmd.complexFilter(complexFilter)
        .outputOptions([
          "-map 0:v",
          "-map [aout]",
          "-c:v copy",
          "-c:a aac",
          "-shortest"
        ])
        .save(outputPath)
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
    const { final_stitched_video, final_dialogue, final_music_url } = req.body;
    
    if (!final_stitched_video || !final_music_url) {
      return res.status(400).json({ error: "Missing required inputs (video and music)" });
    }
    
    const id = uuidv4();
    const videoPath = path.join(TEMP_DIR, `${id}_video.mp4`);
    const dialoguePath = final_dialogue ? path.join(TEMP_DIR, `${id}_dialogue.mp3`) : null;
    const musicPath = path.join(TEMP_DIR, `${id}_music.mp3`);
    const outputPath = path.join(OUTPUT_DIR, `${id}_final.mp4`);
    
    // Download files
    await downloadFile(final_stitched_video, videoPath);
    if (final_dialogue) {
      await downloadFile(final_dialogue, dialoguePath);
    }
    await downloadFile(final_music_url, musicPath);
    
    // Mix video + audio
    await mixVideo(videoPath, dialoguePath, musicPath, outputPath);
    
    res.json({
      message: "✅ Combined video created",
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

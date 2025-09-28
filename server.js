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

async function mixVideo(videoPath, dialoguePath, musicPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .input(dialoguePath)
      .input(musicPath)
      .complexFilter([
        "[1:a]volume=1.0[dialogue]",
        "[2:a]volume=0.85[music]", // -1.5 dB
        "[dialogue][music]amix=inputs=2:duration=longest[aout]"
      ])
      .map("[aout]")
      .outputOptions(["-c:v copy", "-c:a aac", "-shortest"])
      .save(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(err));
  });
}

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/combine", async (req, res) => {
  try {
    await ensureDirectories();
    const { final_stitched_video, final_dialogue, final_music_url } = req.body;

    if (!final_stitched_video || !final_dialogue || !final_music_url) {
      return res.status(400).json({ error: "Missing inputs" });
    }

    const id = uuidv4();
    const videoPath = path.join(TEMP_DIR, `${id}_video.mp4`);
    const dialoguePath = path.join(TEMP_DIR, `${id}_dialogue.mp3`);
    const musicPath = path.join(TEMP_DIR, `${id}_music.mp3`);
    const outputPath = path.join(OUTPUT_DIR, `${id}_final.mp4`);

    await downloadFile(final_stitched_video, videoPath);
    await downloadFile(final_dialogue, dialoguePath);
    await downloadFile(final_music_url, musicPath);

    await mixVideo(videoPath, dialoguePath, musicPath, outputPath);

    res.json({
      message: "✅ Combined video created",
      download_url: `/download/${path.basename(outputPath)}`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Processing failed", details: err.message });
  }
});

app.use("/download", express.static(OUTPUT_DIR));

app.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);

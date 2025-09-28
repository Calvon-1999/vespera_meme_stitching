const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs').promises;
const fssync = require('fs'); // for streams
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

// Explicitly set paths for Railway/Docker
ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
ffmpeg.setFfprobePath('/usr/bin/ffprobe');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const upload = multer({
  dest: '/tmp/uploads/',
  limits: { fileSize: 50 * 1024 * 1024 }
});

const TEMP_DIR = '/tmp';
const OUTPUT_DIR = path.join(TEMP_DIR, 'output');

/* ----------------- Helpers ----------------- */
async function ensureDirectories() {
  for (const dir of [OUTPUT_DIR, '/tmp/uploads', 'uploads', 'outputs', 'temp']) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {}
  }
}

async function downloadFile(url, filepath) {
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    timeout: 60000
  });

  const writer = fssync.createWriteStream(filepath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

/* ----------------- Core Mixing Function ----------------- */
async function mixVideoWithAudio(videoPath, dialoguePath, musicPath, outputPath) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(videoPath);

    command.input(dialoguePath);
    command.input(musicPath);

    const complexFilters = [
      '[1:a]volume=1.0[dialogue]',
      '[2:a]volume=0.6[music]',
      '[dialogue][music]amix=inputs=2:duration=longest[aout]'
    ];

    command
      .complexFilter(complexFilters)
      .map('[aout]')
      .outputOptions(['-c:v copy', '-c:a aac', '-shortest'])
      .save(outputPath)
      .on('end', () => {
        console.log('✅ Video + audio mix completed');
        resolve();
      })
      .on('error', err => {
        console.error('❌ FFmpeg mix error:', err);
        reject(err);
      });
  });
}

/* ----------------- Routes ----------------- */

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'video-processing-api' });
});

/**
 * POST /api/combine
 * Accepts either file uploads OR JSON with URLs
 */
app.post(
  '/api/combine',
  upload.fields([
    { name: 'final_stitched_video', maxCount: 1 },
    { name: 'final_dialogue', maxCount: 1 },
    { name: 'final_music_url', maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      console.log('Incoming body:', req.body); // 👈 debug log
      await ensureDirectories();

      const id = uuidv4();
      const outputFile = path.join(OUTPUT_DIR, `${id}_final.mp4`);

      let videoPath, dialoguePath, musicPath;

      // stitched video
      if (req.files['final_stitched_video']) {
        videoPath = req.files['final_stitched_video'][0].path;
      } else if (req.body.final_stitched_video) {
        videoPath = path.join(TEMP_DIR, `${id}_video.mp4`);
        await downloadFile(req.body.final_stitched_video, videoPath);
      }

      // dialogue
      if (req.files['final_dialogue']) {
        dialoguePath = req.files['final_dialogue'][0].path;
      } else if (req.body.final_dialogue) {
        dialoguePath = path.join(TEMP_DIR, `${id}_dialogue.mp3`);
        await downloadFile(req.body.final_dialogue, dialoguePath);
      }

      // music
      if (req.files['final_music_url']) {
        musicPath = req.files['final_music_url'][0].path;
      } else if (req.body.final_music_url) {
        musicPath = path.join(TEMP_DIR, `${id}_music.mp3`);
        await downloadFile(req.body.final_music_url, musicPath);
      }

      if (!videoPath || !dialoguePath || !musicPath) {
        return res.status(400).json({ error: 'Missing video, dialogue, or music input' });
      }

      await mixVideoWithAudio(videoPath, dialoguePath, musicPath, outputFile);

      res.json({
        message: '✅ Combined video created',
        file: `/download/${path.basename(outputFile)}`
      });
    } catch (err) {
      console.error('❌ Combine error:', err);
      res.status(500).json({ error: 'Processing failed', details: err.message });
    }
  }
);

// Serve outputs
app.use('/download', express.static(OUTPUT_DIR));

/* ----------------- Start Server ----------------- */
async function startServer() {
  await ensureDirectories();
  app.listen(PORT, () => {
    console.log(`🚀 Service running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Combine API: POST http://localhost:${PORT}/api/combine`);
  });
}

startServer().catch(console.error);

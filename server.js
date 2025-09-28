const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const upload = multer({ 
    dest: '/tmp/uploads/',
    limits: { fileSize: 10 * 1024 * 1024 }
});

const TEMP_DIR = '/tmp';
const OUTPUT_DIR = path.join(TEMP_DIR, 'output');

async function ensureDirectories() {
    try {
        await fs.mkdir(OUTPUT_DIR, { recursive: true });
        await fs.mkdir('/tmp/uploads', { recursive: true });
        await fs.mkdir('uploads', { recursive: true });
        await fs.mkdir('outputs', { recursive: true });
        await fs.mkdir('temp', { recursive: true });
    } catch (error) {
        console.log('Directories already exist or error creating:', error.message);
    }
}

async function downloadFile(url, filepath) {
    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 30000
    });

    const writer = require('fs').createWriteStream(filepath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

async function trimAudio(inputPath, outputPath, duration = 60) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .setStartTime(0)
            .setDuration(duration)
            .output(outputPath)
            .on('end', () => {
                console.log('Audio trimming completed');
                resolve();
            })
            .on('error', (err) => {
                console.error('Audio trimming error:', err);
                reject(err);
            })
            .run();
    });
}

async function getVideoDuration(videoPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                reject(err);
            } else {
                const duration = metadata.format.duration;
                resolve(duration);
            }
        });
    });
}

async function getVideoDimensions(videoPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                reject(err);
            } else {
                const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
                resolve({
                    width: videoStream.width,
                    height: videoStream.height
                });
            }
        });
    });
}

async function hasAudioStream(videoPath) {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                resolve(false);
            } else {
                const hasAudio = metadata.streams.some(stream => stream.codec_type === 'audio');
                resolve(hasAudio);
            }
        });
    });
}

async function stitchVideos(videoPaths, outputPath) {
    return new Promise(async (resolve, reject) => {
        try {
            const audioChecks = await Promise.all(videoPaths.map(hasAudioStream));
            const hasAnyAudio = audioChecks.some(hasAudio => hasAudio);
            
            const command = ffmpeg();
            
            videoPaths.forEach(videoPath => {
                command.input(videoPath);
            });

            if (hasAnyAudio) {
                const filterComplex = videoPaths.map((_, index) => {
                    return audioChecks[index] ? `[${index}:v][${index}:a]` : `[${index}:v][${index}:v]`;
                }).join('') + `concat=n=${videoPaths.length}:v=1:a=1[outv][outa]`;

                command
                    .complexFilter(filterComplex)
                    .outputOptions(['-map', '[outv]', '-map', '[outa]']);
            } else {
                const filterComplex = videoPaths.map((_, index) => `[${index}:v]`).join('') + 
                                     `concat=n=${videoPaths.length}:v=1:a=0[outv]`;

                command
                    .complexFilter(filterComplex)
                    .outputOptions(['-map', '[outv]']);
            }

            command
                .output(outputPath)
                .on('end', () => {
                    console.log('Video stitching completed');
                    resolve();
                })
                .on('error', (err) => {
                    console.error('Video stitching error:', err);
                    reject(err);
                })
                .run();
        } catch (error) {
            reject(error);
        }
    });
}

// Enhanced function to handle video, music, and dialogue audio
async function addAudioAndOverlayToVideo(videoPath, musicPath, dialoguePath, outputPath, overlayImagePath = null, overlayOptions = {}) {
    return new Promise(async (resolve, reject) => {
        try {
            const command = ffmpeg(videoPath);
            let inputIndex = 1;
            
            // Add music input
            command.input(musicPath);
            const musicIndex = inputIndex++;
            
            // Add dialogue input if provided
            let dialogueIndex = null;
            if (dialoguePath) {
                command.input(dialoguePath);
                dialogueIndex = inputIndex++;
            }
            
            const videoHasAudio = await hasAudioStream(videoPath);
            
            // Add overlay image if provided
            let overlayIndex = null;
            if (overlayImagePath) {
                command.input(overlayImagePath);
                overlayIndex = inputIndex++;
            }
            
            // Build the complex filter
            let complexFilters = [];
            let videoOutput = '0:v';
            let audioInputs = [];
            
            // Handle overlay image
            if (overlayImagePath) {
                const {
                    position = 'bottom-right',
                    size = '150',
                    margin = '20',
                    opacity = '1.0'
                } = overlayOptions;
                
                let x, y;
                switch (position) {
                    case 'top-left':
                        x = margin;
                        y = margin;
                        break;
                    case 'top-right':
                        x = `W-w-${margin}`;
                        y = margin;
                        break;
                    case 'bottom-left':
                        x = margin;
                        y = `H-h-${margin}`;
                        break;
                    case 'bottom-right':
                    default:
                        x = `W-w-${margin}`;
                        y = `H-h-${margin}`;
                        break;
                }
                
                complexFilters.push(`[${overlayIndex}:v]scale=${size}:-1[overlay]`);
                complexFilters.push(`[0:v][overlay]overlay=${x}:${y}:format=auto,format=yuv420p[v]`);
                videoOutput = '[v]';
            }
            
            // Process audio streams
            // Music with -1.5dB volume
            complexFilters.push(`[${musicIndex}:a]volume=-1.5dB[music]`);
            audioInputs.push('[music]');
            
            // Add dialogue if provided (normal volume)
            if (dialogueIndex !== null) {
                complexFilters.push(`[${dialogueIndex}:a]volume=0dB[dialogue]`);
                audioInputs.push('[dialogue]');
            }
            
            // Add original video audio if it exists
            if (videoHasAudio) {
                complexFilters.push(`[0:a]volume=0dB[videoaudio]`);
                audioInputs.push('[videoaudio]');
            }
            
            // Mix all audio inputs
            if (audioInputs.length > 1) {
                const mixFilter = `${audioInputs.join('')}amix=inputs=${audioInputs.length}:duration=shortest[mixedaudio]`;
                complexFilters.push(mixFilter);
            } else if (audioInputs.length === 1) {
                // Just one audio source, rename it
                complexFilters.push(`[music]acopy[mixedaudio]`);
            }
            
            // Apply all filters
            if (complexFilters.length > 0) {
                command.complexFilter(complexFilters.join('; '));
            }
            
            // Set output mappings
            command.outputOptions([
                '-map', videoOutput,
                '-map', '[mixedaudio]',
                '-c:v', overlayImagePath ? 'libx264' : 'copy',
                '-c:a', 'aac',
                '-shortest'
            ]);

            command
                .output(outputPath)
                .on('end', () => {
                    console.log('Audio mixing and overlay processing completed');
                    resolve();
                })
                .on('error', (err) => {
                    console.error('Audio mixing and overlay processing error:', err);
                    reject(err);
                })
                .run();
        } catch (error) {
            reject(error);
        }
    });
}

async function addOverlayToImage(baseImagePath, overlayImagePath, outputPath, overlayOptions = {}) {
    return new Promise((resolve, reject) => {
        const {
            position = 'bottom-right',
            size = '150',        // Same as video: 150px width
            margin = '20'        // Same as video: 20px margin
        } = overlayOptions;
        
        // Use exact same positioning logic as video overlay
        let x, y;
        switch (position) {
            case 'top-left':
                x = margin;
                y = margin;
                break;
            case 'top-right':
                x = `W-w-${margin}`;
                y = margin;
                break;
            case 'bottom-left':
                x = margin;
                y = `H-h-${margin}`;
                break;
            case 'bottom-right':
            default:
                x = `W-w-${margin}`;
                y = `H-h-${margin}`;
                break;
        }
        
        // Use same filter approach as video: scale overlay to size, then position
        ffmpeg()
            .input(baseImagePath)
            .input(overlayImagePath)
            .complexFilter(`[1:v]scale=${size}:-1[overlay]; [0:v][overlay]overlay=${x}:${y}[out]`)
            .outputOptions([
                '-map', '[out]',
                '-vframes', '1'
            ])
            .output(outputPath)
            .on('end', () => {
                console.log('Image overlay processing completed');
                resolve();
            })
            .on('error', (err) => {
                console.error('Image overlay processing error:', err);
                // If FFmpeg fails, just copy the original image
                require('fs').createReadStream(baseImagePath).pipe(require('fs').createWriteStream(outputPath))
                    .on('close', () => {
                        console.log('Fallback: returned original image without overlay');
                        resolve();
                    })
                    .on('error', reject);
            })
            .run();
    });
}

app.post('/api/add-overlay', async (req, res) => {
    const jobId = uuidv4();
    console.log(`Starting overlay job ${jobId}`);
    
    try {
        const { final_stitch_video, final_music_url, final_dialogue, overlay_image_url, overlay_options } = req.body;
        
        if (!final_stitch_video || !final_music_url) {
            return res.status(400).json({ 
                error: 'Invalid input. Expected final_stitch_video and final_music_url' 
            });
        }

        const jobDir = path.join(TEMP_DIR, jobId);
        await fs.mkdir(jobDir, { recursive: true });

        console.log('Step 1: Downloading video...');
        const videoPath = path.join(jobDir, 'input_video.mp4');
        await downloadFile(final_stitch_video, videoPath);

        console.log('Step 2: Processing music audio...');
        const musicPath = path.join(jobDir, 'music.mp3');
        const trimmedMusicPath = path.join(jobDir, 'music_trimmed.mp3');
        await downloadFile(final_music_url, musicPath);
        await trimAudio(musicPath, trimmedMusicPath, 60);

        let dialoguePath = null;
        if (final_dialogue) {
            console.log('Step 3: Processing dialogue audio...');
            dialoguePath = path.join(jobDir, 'dialogue.mp3');
            await downloadFile(final_dialogue, dialoguePath);
        }

        let overlayImagePath = null;
        if (overlay_image_url) {
            console.log(`Step ${final_dialogue ? '4' : '3'}: Downloading overlay image...`);
            overlayImagePath = path.join(jobDir, 'overlay_image.png');
            await downloadFile(overlay_image_url, overlayImagePath);
        }

        console.log(`Step ${final_dialogue && overlay_image_url ? '5' : final_dialogue || overlay_image_url ? '4' : '3'}: Adding audio and overlay...`);
        const finalVideoPath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
        await addAudioAndOverlayToVideo(videoPath, trimmedMusicPath, dialoguePath, finalVideoPath, overlayImagePath, overlay_options || {});

        const finalDuration = await getVideoDuration(finalVideoPath);
        const stats = await fs.stat(finalVideoPath);

        await fs.rm(jobDir, { recursive: true, force: true });

        console.log(`Job ${jobId} completed successfully`);

        res.json({
            success: true,
            jobId: jobId,
            downloadUrl: `/download/${jobId}`,
            finalVideoUrl: `${req.protocol}://${req.get('host')}/download/${jobId}`,
            videoStats: {
                duration: finalDuration,
                fileSize: stats.size,
                fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2)
            },
            audioTracksAdded: {
                music: true,
                dialogue: !!final_dialogue,
                originalVideoAudio: await hasAudioStream(videoPath)
            },
            overlayApplied: !!overlay_image_url,
            message: `Successfully added ${final_dialogue ? 'music, dialogue' : 'music'} and ${overlay_image_url ? 'overlay' : 'no overlay'} to video`
        });

    } catch (error) {
        console.error(`Job ${jobId} failed:`, error);
        res.status(500).json({
            success: false,
            error: error.message,
            jobId: jobId
        });
    }
});

app.post('/api/add-image-overlay', async (req, res) => {
    const jobId = uuidv4();
    console.log(`Starting image overlay job ${jobId}`);
    
    try {
        const { final_image_url, overlay_image_url, overlay_options } = req.body;
        
        if (!final_image_url || !overlay_image_url) {
            return res.status(400).json({ 
                error: 'Invalid input. Expected final_image_url and overlay_image_url' 
            });
        }

        const jobDir = path.join(TEMP_DIR, jobId);
        await fs.mkdir(jobDir, { recursive: true });

        console.log('Step 1: Downloading base image...');
        const baseImagePath = path.join(jobDir, 'base_image.png');
        await downloadFile(final_image_url, baseImagePath);

        console.log('Step 2: Downloading overlay image...');
        const overlayImagePath = path.join(jobDir, 'overlay_image.png');
        await downloadFile(overlay_image_url, overlayImagePath);

        console.log('Step 3: Adding overlay to image...');
        const finalImagePath = path.join(OUTPUT_DIR, `final_image_${jobId}.png`);
        await addOverlayToImage(baseImagePath, overlayImagePath, finalImagePath, overlay_options || {});

        const stats = await fs.stat(finalImagePath);

        await fs.rm(jobDir, { recursive: true, force: true });

        console.log(`Image overlay job ${jobId} completed successfully`);

        res.json({
            success: true,
            jobId: jobId,
            downloadUrl: `/download-image/${jobId}`,
            finalImageUrl: `${req.protocol}://${req.get('host')}/download-image/${jobId}`,
            imageStats: {
                fileSize: stats.size,
                fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2)
            },
            overlayApplied: true,
            message: 'Successfully added overlay to image'
        });

    } catch (error) {
        console.error(`Image overlay job ${jobId} failed:`, error);
        res.status(500).json({
            success: false,
            error: error.message,
            jobId: jobId
        });
    }
});

app.post('/api/stitch-videos', async (req, res) => {
    const jobId = uuidv4();
    console.log(`Starting video stitching job ${jobId}`);
    
    try {
        const { videos, mv_audio, final_dialogue, overlay_image_url, overlay_options } = req.body;
        
        if (!videos || !Array.isArray(videos) || !mv_audio) {
            return res.status(400).json({ 
                error: 'Invalid input. Expected videos array and mv_audio URL' 
            });
        }

        const jobDir = path.join(TEMP_DIR, jobId);
        await fs.mkdir(jobDir, { recursive: true });

        console.log('Step 1: Processing music audio...');
        const musicPath = path.join(jobDir, 'music.mp3');
        const trimmedMusicPath = path.join(jobDir, 'music_trimmed.mp3');
        await downloadFile(mv_audio, musicPath);
        await trimAudio(musicPath, trimmedMusicPath, 60);

        let dialoguePath = null;
        if (final_dialogue) {
            console.log('Step 2: Processing dialogue audio...');
            dialoguePath = path.join(jobDir, 'dialogue.mp3');
            await downloadFile(final_dialogue, dialoguePath);
        }

        let overlayImagePath = null;
        if (overlay_image_url) {
            console.log(`Step ${final_dialogue ? '3' : '2'}: Downloading overlay image...`);
            overlayImagePath = path.join(jobDir, 'overlay_image.png');
            await downloadFile(overlay_image_url, overlayImagePath);
        }

        console.log(`Step ${final_dialogue && overlay_image_url ? '4' : final_dialogue || overlay_image_url ? '3' : '2'}: Sorting and downloading videos...`);
        const sortedVideos = videos.sort((a, b) => {
            const sceneA = parseInt(a.scene_number, 10);
            const sceneB = parseInt(b.scene_number, 10);
            return sceneA - sceneB;
        });

        console.log('Video processing order:', sortedVideos.map(v => `Scene ${v.scene_number}`).join(' -> '));

        const videoPaths = [];
        for (let i = 0; i < sortedVideos.length; i++) {
            const video = sortedVideos[i];
            const videoPath = path.join(jobDir, `video_${String(video.scene_number).padStart(3, '0')}.mp4`);
            await downloadFile(video.final_video_url, videoPath);
            videoPaths.push(videoPath);
            console.log(`Downloaded video ${i + 1}/${sortedVideos.length}: Scene ${video.scene_number}`);
        }

        console.log(`Step ${final_dialogue && overlay_image_url ? '5' : final_dialogue || overlay_image_url ? '4' : '3'}: Stitching videos...`);
        const stitchedVideoPath = path.join(jobDir, 'stitched_video.mp4');
        await stitchVideos(videoPaths, stitchedVideoPath);

        console.log(`Step ${final_dialogue && overlay_image_url ? '6' : final_dialogue || overlay_image_url ? '5' : '4'}: Adding audio and overlay to final video...`);
        const finalVideoPath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
        await addAudioAndOverlayToVideo(stitchedVideoPath, trimmedMusicPath, dialoguePath, finalVideoPath, overlayImagePath, overlay_options || {});

        const finalDuration = await getVideoDuration(finalVideoPath);
        const stats = await fs.stat(finalVideoPath);

        await fs.rm(jobDir, { recursive: true, force: true });

        console.log(`Job ${jobId} completed successfully`);

        res.json({
            success: true,
            jobId: jobId,
            downloadUrl: `/download/${jobId}`,
            finalVideoUrl: `${req.protocol}://${req.get('host')}/download/${jobId}`,
            videoStats: {
                duration: finalDuration,
                fileSize: stats.size,
                fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2)
            },
            processedVideos: videos.length,
            sceneOrder: sortedVideos.map(v => parseInt(v.scene_number, 10)),
            audioTracksAdded: {
                music: true,
                dialogue: !!final_dialogue
            },
            overlayApplied: !!overlay_image_url,
            message: `Successfully processed ${videos.length} videos with music${final_dialogue ? ', dialogue' : ''} audio track${overlay_image_url ? ' and image overlay' : ''}`
        });

    } catch (error) {
        console.error(`Job ${jobId} failed:`, error);
        res.status(500).json({
            success: false,
            error: error.message,
            jobId: jobId
        });
    }
});

app.get('/download/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const filePath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
        
        await fs.access(filePath);
        const stats = await fs.stat(filePath);
        
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="final_video_${jobId}.mp4"`);
        res.setHeader('Content-Length', stats.size);
        
        const fileStream = require('fs').createReadStream(filePath);
        fileStream.pipe(res);
        
    } catch (error) {
        res.status(404).json({ 
            error: 'Video file not found or not accessible',
            details: error.message 
        });
    }
});

app.get('/download-image/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const filePath = path.join(OUTPUT_DIR, `final_image_${jobId}.png`);
        
        await fs.access(filePath);
        
        // Return URL instead of binary data
        res.json({
            success: true,
            imageUrl: `${req.protocol}://${req.get('host')}/serve-image/${jobId}`,
            jobId: jobId
        });
        
    } catch (error) {
        res.status(404).json({ 
            error: 'Image file not found or not accessible',
            details: error.message 
        });
    }
});

// Add endpoint to serve the actual image binary
app.get('/serve-image/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const filePath = path.join(OUTPUT_DIR, `final_image_${jobId}.png`);
        
        await fs.access(filePath);
        const stats = await fs.stat(filePath);
        
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Length', stats.size);
        
        const fileStream = require('fs').createReadStream(filePath);
        fileStream.pipe(res);
        
    } catch (error) {
        res.status(404).json({ 
            error: 'Image file not found or not accessible',
            details: error.message 
        });
    }
});

app.get('/stream/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const filePath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
        
        await fs.access(filePath);
        const stats = await fs.stat(filePath);
        
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', stats.size);
        res.setHeader('Accept-Ranges', 'bytes');
        
        const fileStream = require('fs').createReadStream(filePath);
        fileStream.pipe(res);
        
    } catch (error) {
        res.status(404).json({ 
            error: 'Video file not found or not accessible',
            details: error.message 
        });
    }
});

app.get('/api/status/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const filePath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
        
        try {
            await fs.access(filePath);
            const stats = await fs.stat(filePath);
            const duration = await getVideoDuration(filePath);
            
            res.json({
                status: 'completed',
                jobId: jobId,
                completed: true,
                downloadUrl: `/download/${jobId}`,
                streamUrl: `/stream/${jobId}`,
                finalVideoUrl: `${req.protocol}://${req.get('host')}/download/${jobId}`,
                videoStats: {
                    duration: duration,
                    fileSize: stats.size,
                    fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2),
                    createdAt: stats.birthtime
                }
            });
        } catch (error) {
            res.json({
                status: 'processing',
                jobId: jobId,
                completed: false,
                message: 'Video is still being processed or job not found'
            });
        }
        
    } catch (error) {
        res.status(500).json({
            status: 'error',
            jobId: req.params.jobId,
            completed: false,
            error: error.message
        });
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        service: 'Enhanced Video Processing Service with Dialogue',
        timestamp: new Date().toISOString()
    });
});

app.get('/', (req, res) => {
    res.json({
        service: 'Enhanced Video Processing Service with Dialogue',
        version: '6.0.0',
        endpoints: {
            addOverlay: 'POST /api/add-overlay (single video + music + dialogue + overlay)',
            addImageOverlay: 'POST /api/add-image-overlay (image + overlay)',
            stitchVideos: 'POST /api/stitch-videos (multiple videos + music + dialogue + overlay)',
            download: 'GET /download/:jobId (download video file)',
            downloadImage: 'GET /download-image/:jobId (download image file)',
            stream: 'GET /stream/:jobId (stream video in browser)',
            status: 'GET /api/status/:jobId (check job status)',
            health: 'GET /health'
        },
        audioMixing: {
            musicVolume: '-1.5dB',
            dialogueVolume: '0dB (normal)',
            videoAudioVolume: '0dB (normal)',
            mixingMethod: 'amix with shortest duration'
        }
    });
});

async function startServer() {
    await ensureDirectories();
    
    app.listen(PORT, () => {
        console.log(`Enhanced Video Processing Service with Dialogue running on port ${PORT}`);
        console.log(`Health check: http://localhost:${PORT}/health`);
        console.log(`API documentation: http://localhost:${PORT}/`);
        console.log('Audio mixing: Music (-1.5dB), Dialogue (0dB), Video Audio (0dB)');
    });
}

startServer().catch(console.error);

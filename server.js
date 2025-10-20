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

            const wrappedTopText = wrapText(topText, 30);
            const wrappedBottomText = wrapText(bottomText, 30);
            
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

            const escapedFontPath = CUSTOM_FONT_PATH.replace(/:/g, '\\:');

            if (!fs.existsSync(CUSTOM_FONT_PATH)) {
                console.warn(`⚠️  Warning: Font file not found at ${CUSTOM_FONT_PATH}`);
            }

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

            // Build the complete complex filter chain
            let complexFilter = [];
            
            // Check if overlay image exists
            console.log(`🔍 Checking for overlay image at: ${OVERLAY_IMAGE_PATH}`);
            const hasOverlay = fs.existsSync(OVERLAY_IMAGE_PATH);
            console.log(`📁 Overlay image exists: ${hasOverlay}`);
            
            if (hasOverlay) {
                console.log('🖼️  Adding overlay image and branding...');
                
                const overlayDimensions = await getImageDimensions(OVERLAY_IMAGE_PATH);
                console.log(`📐 Overlay image dimensions: ${overlayDimensions.width}x${overlayDimensions.height}`);
                console.log(`📐 Video dimensions: ${width}x${height}`);
                
                const escapedImagePath = OVERLAY_IMAGE_PATH.replace(/:/g, '\\:');
                const overlayX = `w-${overlayDimensions.width}-20`; // 20px from right
                const overlayY = `h-${overlayDimensions.height}-20`; // 20px from bottom
                
                // Step 1: Load the overlay image
                complexFilter.push(`movie=${escapedImagePath}[overlay]`);
                
                // Step 2: Overlay the image on the video
                complexFilter.push(`[0:v][overlay]overlay=${overlayX}:${overlayY}[v1]`);
                
                // Now we'll add text on top of [v1]
                let currentStream = 'v1';
                let streamCounter = 2;
                
                // Step 3: Add top meme text
                if (needsMemeText && topText && topLines.length > 0) {
                    topLines.forEach((line, index) => {
                        const escapedLine = escapeTextSimple(line);
                        const yPos = verticalOffset + (index * lineHeight);
                        const nextStream = `v${streamCounter}`;
                        complexFilter.push(
                            `[${currentStream}]drawtext=${drawtextParams}:text='${escapedLine}':x=(w-text_w)/2:y=${yPos}[${nextStream}]`
                        );
                        currentStream = nextStream;
                        streamCounter++;
                    });
                }
                
                // Step 4: Add bottom meme text
                if (needsMemeText && bottomText && bottomLines.length > 0) {
                    const totalBottomHeight = bottomLines.length * lineHeight;
                    const bottomOffset = verticalOffset + 40; // Move higher to avoid overlay
                    bottomLines.forEach((line, index) => {
                        const escapedLine = escapeTextSimple(line);
                        const yPos = `h-${totalBottomHeight - (index * lineHeight)}-${bottomOffset}`;
                        const nextStream = `v${streamCounter}`;
                        complexFilter.push(
                            `[${currentStream}]drawtext=${drawtextParams}:text='${escapedLine}':x=(w-text_w)/2:y=${yPos}[${nextStream}]`
                        );
                        currentStream = nextStream;
                        streamCounter++;
                    });
                }
                
                // Step 5: Add branding text on top of the overlay image
                const brandingText = projectName ? `luna.fun/${projectName}` : "luna.fun";
                const brandingFontSize = Math.max(24, Math.floor(fontSize * 0.8)); // Much larger!
                const brandingStrokeWidth = Math.max(2, Math.floor(brandingFontSize / 12));
                
                const brandingParams = [
                    `fontfile='${escapedFontPath}'`,
                    `fontcolor=white`,
                    `fontsize=${brandingFontSize}`,
                    `bordercolor=black`,
                    `borderw=${brandingStrokeWidth}`,
                    `shadowcolor=black@0.7`, // Darker shadow for better visibility
                    `shadowx=3`,
                    `shadowy=3`
                ].join(':');

                const escapedBrandingText = escapeTextSimple(brandingText);
                // Position branding more prominently - centered on overlay
                const brandingX = `w-${overlayWidth}-20+${Math.floor(overlayWidth/2)}-text_w/2`; // Center horizontally on overlay
                const brandingY = `h-${overlayHeight}-20+20`; // 20px from top of overlay
                
                // Final filter - no output label needed
                complexFilter.push(
                    `[${currentStream}]drawtext=${brandingParams}:text='${escapedBrandingText}':x=${brandingX}:y=${brandingY}`
                );
                
                console.log(`✅ Overlay (${overlayWidth}x${overlayHeight}) positioned at: x=${overlayX}, y=${overlayY}`);
                console.log(`✅ Branding "${brandingText}" positioned at: x=${brandingX}, y=${brandingY}`);
                
            } else {
                console.warn('⚠️  Overlay image not found at:', OVERLAY_IMAGE_PATH);
                console.warn('⚠️  Adding text only without overlay');
                
                // Fallback: Just add text without overlay
                let currentStream = '0:v';
                let streamCounter = 1;
                
                // Top text
                if (needsMemeText && topText && topLines.length > 0) {
                    topLines.forEach((line, index) => {
                        const escapedLine = escapeTextSimple(line);
                        const yPos = verticalOffset + (index * lineHeight);
                        const nextStream = `v${streamCounter}`;
                        complexFilter.push(
                            `[${currentStream}]drawtext=${drawtextParams}:text='${escapedLine}':x=(w-text_w)/2:y=${yPos}[${nextStream}]`
                        );
                        currentStream = nextStream;
                        streamCounter++;
                    });
                }
                
                // Bottom text
                if (needsMemeText && bottomText && bottomLines.length > 0) {
                    const totalBottomHeight = bottomLines.length * lineHeight;
                    const bottomOffset = verticalOffset + 40;
                    bottomLines.forEach((line, index) => {
                        const escapedLine = escapeTextSimple(line);
                        const yPos = `h-${totalBottomHeight - (index * lineHeight)}-${bottomOffset}`;
                        const nextStream = `v${streamCounter}`;
                        complexFilter.push(
                            `[${currentStream}]drawtext=${drawtextParams}:text='${escapedLine}':x=(w-text_w)/2:y=${yPos}[${nextStream}]`
                        );
                        currentStream = nextStream;
                        streamCounter++;
                    });
                }
                
                // Branding in bottom-left
                const brandingText = projectName ? `luna.fun/${projectName}` : "luna.fun";
                const brandingFontSize = Math.max(12, Math.floor(fontSize * 0.4));
                const brandingStrokeWidth = Math.max(1, Math.floor(brandingFontSize / 15));
                
                const brandingParams = [
                    `fontfile='${escapedFontPath}'`,
                    `fontcolor=white`,
                    `fontsize=${brandingFontSize}`,
                    `bordercolor=black`,
                    `borderw=${brandingStrokeWidth}`,
                    `shadowcolor=black@0.3`,
                    `shadowx=1`,
                    `shadowy=1`
                ].join(':');

                const escapedBrandingText = escapeTextSimple(brandingText);
                const brandingYPos = `h-${brandingFontSize + 10}`;
                
                // Final output
                complexFilter.push(
                    `[${currentStream}]drawtext=${brandingParams}:text='${escapedBrandingText}':x=20:y=${brandingYPos}`
                );
            }

            console.log('🎬 FFmpeg complex filter chain:');
            complexFilter.forEach((filter, idx) => {
                console.log(`   ${idx + 1}. ${filter}`);
            });
            console.log(`📊 Total meme text lines: ${topLines.length + bottomLines.length}`);

            // Execute FFmpeg with the complex filter
            const ffmpegCmd = ffmpeg()
                .input(videoPath)
                .complexFilter(complexFilter)
                .videoCodec('libx264')
                .audioCodec('copy')
                .outputOptions(['-preset', 'fast', '-crf', '23'])
                .on('start', (cmd) => {
                    console.log('🎬 FFmpeg command:', cmd);
                })
                .on('stderr', (line) => {
                    if (line.includes('Error') || line.includes('Invalid') || line.includes('Cannot find')) {
                        console.error('⚠️ FFmpeg stderr:', line);
                    }
                })
                .on('error', (err) => {
                    console.error('❌ FFmpeg error:', err.message);
                    reject(err);
                })
                .on('end', () => {
                    console.log('✅ Meme text overlay complete');
                    resolve();
                })
                .save(outputPath);

        } catch (err) {
            console.error('❌ Error in addMemeText:', err);
            reject(err);
        }
    });
}

// Keep the helper function
function escapeTextSimple(text) {
    if (!text) return '';
    text = text.replace(/\\/g, '\\\\');
    text = text.replace(/'/g, "'\\\\''");
    text = text.replace(/:/g, '\\:');
    return text;
}

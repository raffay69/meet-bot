import { GoogleAIFileManager, FileState } from "@google/generative-ai/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from 'fs';
import path from 'path';
import { exec } from "child_process";

// command to split the video in 40min parts
// ffmpeg -i file_name.mp4 -c copy -map 0 -f segment -segment_time 2400 -reset_timestamps 1 folder_name/output%03d.mp4

const fileManager = new GoogleAIFileManager("AIzaSyBbK3k2W8FR7weaxE9WwDIxhXKZT_uVr04");
const RETRY_DELAYS = [1000, 2000, 5000, 10000]; // Increasing delays between retries in ms
const CONCURRENT_LIMIT = 2; // Process only 2 videos at a time

// Helper functions for optimization
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(operation, retryCount = 0) {
  try {
    return await operation();
  } catch (error) {
    if (error.message?.includes('overloaded') && retryCount < RETRY_DELAYS.length) {
      console.log(`Retrying after ${RETRY_DELAYS[retryCount]}ms...`);
      await sleep(RETRY_DELAYS[retryCount]);
      return withRetry(operation, retryCount + 1);
    }
    throw error;
  }
}

async function splitVideo(inputFile) {
  const baseName = path.basename(inputFile, path.extname(inputFile));
  const outputFolder = path.join(path.dirname(inputFile), baseName);

  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder, { recursive: true });
  }

  const outputPattern = path.join(outputFolder, 'output%03d.mp4');
  const command = `ffmpeg -i "${inputFile}" -c copy -map 0 -f segment -segment_time 2400 -reset_timestamps 1 "${outputPattern}"`;

  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error executing FFmpeg: ${error.message}`);
        reject(error);
        return;
      }
      
      // Log FFmpeg output but don't treat it as an error
      if (stderr) {
        console.log(`FFmpeg output: ${stderr}`);
      }

      // Verify files were created
      const files = fs.readdirSync(outputFolder);
      const videoFiles = files.filter(file => file.endsWith('.mp4'));
      console.log(`Created ${videoFiles.length} video segments`);
      
      resolve(outputFolder);
    });
  });
}

// Your original uploadVideos function
async function uploadVideos(folderPath) {
  try {
    console.log(`Starting upload process for folder: ${folderPath}`);
    const parts_summary = [];
    const files = await fs.promises.readdir(folderPath);
    const videoFiles = files.filter(file => file.endsWith('.mp4'));
    const uris = [];

    console.log(`Found ${videoFiles.length} video files to process`);

    // Process files in batches
    for (let i = 0; i < videoFiles.length; i += CONCURRENT_LIMIT) {
      const batch = videoFiles.slice(i, i + CONCURRENT_LIMIT);
      
      for (const file of batch) {
        const filePath = path.join(folderPath, file);
        console.log(`Uploading: ${file}`);

        // Upload with retry
        const uploadResult = await withRetry(async () => {
          return await fileManager.uploadFile(filePath, {
            mimeType: "video/mp4",
            displayName: file,
          });
        });

        console.log(`Uploaded: ${file}, waiting for processing...`);

        // Wait for processing
        let fileDetails = await fileManager.getFile(uploadResult.file.name);
        while (fileDetails.state === FileState.PROCESSING) {
          process.stdout.write(".");
          await sleep(10000);
          fileDetails = await fileManager.getFile(uploadResult.file.name);
        }

        if (fileDetails.state === FileState.FAILED) {
          console.error(`Video processing failed for ${file}.`);
          continue;
        }

        uris.push({
          filename: file,
          uri: uploadResult.file.uri
        });

        console.log(
          `Uploaded file ${uploadResult.file.displayName} as: ${uploadResult.file.uri}`
        );
      }

      // Add delay between batches
      if (i + CONCURRENT_LIMIT < videoFiles.length) {
        await sleep(5000);
      }
    }

    // Process each URI with retry
    for (const { uri, filename } of uris) {
      const genAI = new GoogleGenerativeAI("AIzaSyBbK3k2W8FR7weaxE9WwDIxhXKZT_uVr04");
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });

      const result = await withRetry(async () => {
        return await model.generateContent([
          `
        Task Overview: Analyze the meeting transcript or recording and generate a comprehensive summary in the specified format. Ensure the summary is exhaustive, detailed, and logically organized. Focus on including all discussed points, key exchanges, and decisions without omitting any context.

        Required Outputs:
        1. High-Level Summary:
        !!Provide a detailed summary of the entire meeting, including all key topics, decisions, and notable discussions.
        !!Ensure all topics are covered comprehensively, emphasizing important points such as updates, reviews, and resolutions.
        !!Organize the summary using headings or bullet points for clarity.

        2. Speaker-Specific Summary:
        !!Summarize each participant's contributions individually, identified by their name.
        !!Include their key statements, questions, proposals, and roles during the meeting.
        !!Highlight any unique perspectives or questions raised by each speaker.

        3. Upcoming Tasks:
        !!List all follow-up actions, assignments, or tasks mentioned during the meeting.
        !!Clearly specify the task, the responsible individual or team, and any deadlines.
        !!Use bullet points for better readability and ensure tasks are actionable and precise.

        Formatting Guidelines:
        !!Use bold headings for different sections (e.g., High-Level Summary, Speaker-Specific Summary, Upcoming Tasks).
        !!Organize the content logically, ensuring no gaps in detail or understanding.
        !!Provide information in a structured, clear, and professional manner.

        `,
          {
            fileData: {
              fileUri: uri,
              mimeType: "video/mp4",
            },
          },
        ]);
      });

      parts_summary.push({
        filename: filename,
        summary: result.response.text()
      });
      
      // Add delay between processing videos
      await sleep(2000);
      
      if(result.response.text().length>0){
        console.log(`${filename} summary is done`)
      };
    }
    return parts_summary;
  } catch (error) {
    console.error("Error uploading videos:", error);
    throw error; // Propagate error to main execution
  }
}

async function complete_summary(parts_summary) {
  const genAI = new GoogleGenerativeAI("AIzaSyBbK3k2W8FR7weaxE9WwDIxhXKZT_uVr04");
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });

  const result = await withRetry(async () => {
    return await model.generateContent({
      contents: [{
        role: "user",
        parts: [
          {
            text: `
              You are a highly capable assistant specialized in creating structured and exhaustive meeting summaries. Below is a collection of summaries from various parts of a meeting. Your task is to use this information to generate the following outputs in a detailed and organized format:

              ### Outputs Required:

              **1. High-Level Summary:**  
              - Combine all part-specific summaries into a single, cohesive, and detailed overview.  
              - The summary should capture all topics discussed, decisions made, and key exchanges in a logical flow.  
              - Ensure that every aspect of the meeting is covered comprehensively while maintaining readability.  

              **2. Speaker-Specific Summary:**  
              - Summarize each participant's contributions individually.  
              - Use the speaker's name (if provided) and detail what they discussed, proposed, asked, or contributed during the meeting.  
              - Highlight any unique insights, questions, or decisions attributed to each participant.  

              **3. Upcoming Tasks:**  
              - List all tasks, action points, follow-ups, and deadlines mentioned in the summaries.  
              - Clearly specify:  
                - The task or action point.  
                - The individual or team responsible.  
                - Any associated deadlines or expected outcomes.  
              - Use a structured and concise bullet-point format for clarity.  

              ---

              ### Part-Specific Summaries:  
              ${parts_summary.map((part) => `- **${part.filename}**: ${part.summary}`).join("\n")}

              ---

              ### Formatting Guidelines:  
              - Use bold headings to separate sections (e.g., **High-Level Summary**, **Speaker-Specific Summary**, **Upcoming Tasks**).  
              - Ensure a logical and natural flow within each section, avoiding unnecessary repetition.  
              - Present the information in a clear, professional, and organized manner.  
              - Use bullet points, subheadings, or numbered lists where appropriate for better readability.  

              Generate the complete, structured summary now.
              `
          }
        ]
      }]
    });
  });

  console.log("complete summary");
  console.log(result.response.text());
}

// Main execution with better error handling
(async () => {
  try {
    console.log("Starting video processing...");
    
    // Split video
    console.log("Splitting video...");
    const folder_path = await splitVideo('meet.mp4');
    console.log("Video split complete. Proceeding to upload...");
    
    // Upload and process videos
    console.log("Starting upload process...");
    const parts_summary = await uploadVideos(folder_path);
    console.log("Upload and processing complete.");
    
    // Generate complete summary
    if (parts_summary && parts_summary.length > 0) {
      console.log("Generating complete summary...");
      await complete_summary(parts_summary);
    } else {
      console.error("No summaries generated from video parts.");
    }
  } catch (error) {
    console.error("Error in main execution:", error);
    process.exit(1);
  }
})();


//add email functionality (contain meeting video , summary)
//make the bot (selenium)
// try making an app interface (electron)

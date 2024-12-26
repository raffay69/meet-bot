// Make sure to include these imports:
import { GoogleAIFileManager, FileState } from "@google/generative-ai/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
const fileManager = new GoogleAIFileManager("AIzaSyBbK3k2W8FR7weaxE9WwDIxhXKZT_uVr04");

const uploadResult = await fileManager.uploadFile(
  `input.mp4`,
  {
    mimeType: "video/mp4",
    displayName: "Big Buck Bunny",
  },
);

let file = await fileManager.getFile(uploadResult.file.name);
while (file.state === FileState.PROCESSING) {
  process.stdout.write(".");
  // Sleep for 10 seconds
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  // Fetch the file from the API again
  file = await fileManager.getFile(uploadResult.file.name);
}

if (file.state === FileState.FAILED) {
  throw new Error("Video processing failed.");
}

// View the response.
console.log(
  `Uploaded file ${uploadResult.file.displayName} as: ${uploadResult.file.uri}`,
);

const genAI = new GoogleGenerativeAI("AIzaSyBbK3k2W8FR7weaxE9WwDIxhXKZT_uVr04");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const result = await model.generateContent([
  `
Analyze the entire meeting transcript or recording and generate the following outputs:

1. **High-Level Summary:**
   Provide a comprehensive summary that includes everything discussed during the meeting, covering key topics, decisions, and any relevant exchanges. This should be an overarching summary that captures all aspects of the meeting.

2. **Speaker-Specific Summary:**
   For each participant, provide a summary of their individual contributions. Identify the speaker by their name (which can be extracted from their profile picture or the name displayed in the meeting interface). The summary should include what each speaker discussed, asked, or contributed during the meeting.

3. **Upcoming Tasks:**
   If there are any actions, tasks, or future events mentioned in the meeting, highlight them separately. These should include any deadlines, follow-ups, or specific tasks assigned to individuals or teams. Mention who is responsible for each task and what is expected.

### Additional Guidelines:
- Ensure that speaker-specific summaries are clearly identified, ideally using the speaker's name.
- When highlighting upcoming tasks, clearly separate them from the general summary and use bullet points or a similar format to make them stand out.
- For the high-level summary, focus on providing a broad view, ensuring that you include all major discussion points.
`,
  {
    fileData: {
      fileUri: uploadResult.file.uri,
      mimeType: uploadResult.file.mimeType,
    },
  },
]);
console.log(result.response.text());
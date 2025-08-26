const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration
const corsOptions = {
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, '.')));

const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

async function extractTextFromPDF(buffer) {
    try {
        const data = await pdfParse(buffer);
        return data.text || 'Unable to extract text from PDF';
    } catch (error) {
        throw new Error('Failed to parse PDF: ' + error.message);
    }
}

async function extractTextFromDocx(buffer) {
    try {
        const result = await mammoth.extractRawText({ buffer });
        return result.value || 'Unable to extract text from DOCX';
    } catch (error) {
        throw new Error('Failed to parse DOCX: ' + error.message);
    }
}

async function extractTextFromFile(file) {
    if (!file || !file.buffer) {
        throw new Error('No file provided');
    }

    const filename = file.originalname.toLowerCase();
    
    if (filename.endsWith('.pdf')) {
        return await extractTextFromPDF(file.buffer);
    } else if (filename.endsWith('.docx')) {
        return await extractTextFromDocx(file.buffer);
    } else if (filename.endsWith('.txt')) {
        return file.buffer.toString('utf8');
    } else {
        throw new Error('Unsupported file format. Please use PDF, DOCX, or TXT files.');
    }
}

async function callGeminiAPI(documentText, rubricText, customInstructions = '') {
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
        throw new Error('Gemini API key not configured on server');
    }

    const prompt = `You are an academic evaluator. Analyze this document against the rubric and provide a simple, concise evaluation.

RUBRIC:
${rubricText}

DOCUMENT TO EVALUATE:
${documentText}

${customInstructions ? `ADDITIONAL INSTRUCTIONS: ${customInstructions}` : ''}

Please provide your response in this JSON format with bullet points:
{
    "score": "X/Y or percentage", 
    "feedback": "• Main strength of the document\n• Key area that needs improvement\n• Specific suggestion for enhancement\n• Overall assessment in one sentence"
}`;

    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const content = response.text();

        try {
            // Clean up the content - remove json code blocks and backticks
            let cleanContent = content;
            cleanContent = cleanContent.replace(/```json\s*/g, '');
            cleanContent = cleanContent.replace(/```\s*/g, '');
            cleanContent = cleanContent.trim();
            
            const parsed = JSON.parse(cleanContent);
            return parsed;
        } catch (parseError) {
            // If parsing fails, try to extract score and feedback manually
            let extractedScore = "Analysis Complete";
            let extractedFeedback = content;
            
            // Try to find score pattern
            const scoreMatch = content.match(/"score":\s*"([^"]+)"/);
            if (scoreMatch) {
                extractedScore = scoreMatch[1];
            }
            
            // Try to find feedback pattern and clean it
            const feedbackMatch = content.match(/"feedback":\s*"([^"]+)"/);
            const feedbackArrayMatch = content.match(/"feedback":\s*\[([^\]]+)\]/);
            
            if (feedbackMatch) {
                extractedFeedback = feedbackMatch[1].replace(/\\n/g, '\n');
            } else if (feedbackArrayMatch) {
                // Handle array format
                extractedFeedback = feedbackArrayMatch[1]
                    .replace(/"/g, '')
                    .replace(/,/g, '\n')
                    .replace(/\\n/g, '\n')
                    .trim();
            } else {
                // Clean up any JSON artifacts from the feedback
                extractedFeedback = content
                    .replace(/```json/g, '')
                    .replace(/```/g, '')
                    .replace(/{\s*"score":\s*"[^"]*",?\s*/g, '')
                    .replace(/"feedback":\s*"/g, '')
                    .replace(/"\s*}/g, '')
                    .replace(/\\n/g, '\n')
                    .trim();
                    
                // Ensure we have some feedback
                if (!extractedFeedback || extractedFeedback.length < 10) {
                    extractedFeedback = "• Analysis completed\n• Please review the document for quality\n• Consider the rubric requirements\n• Make improvements as needed";
                }
            }
            
            return {
                score: extractedScore,
                feedback: extractedFeedback
            };
        }
    } catch (error) {
        console.error('Gemini API Error:', error.message);
        
        if (error.message.includes('API_KEY_INVALID')) {
            throw new Error('Invalid Gemini API key');
        } else if (error.message.includes('QUOTA_EXCEEDED')) {
            throw new Error('API quota exceeded. Please try again later.');
        } else if (error.message.includes('SAFETY')) {
            throw new Error('Content was blocked by safety filters. Please try with different content.');
        } else {
            throw new Error('Gemini API request failed: ' + error.message);
        }
    }
}

app.post('/api/analyze', upload.fields([
    { name: 'pdfFile', maxCount: 1 },
    { name: 'rubricFile', maxCount: 1 }
]), async (req, res) => {
    try {
        const { customInstructions } = req.body;
        const pdfFile = req.files?.pdfFile?.[0];
        const rubricFile = req.files?.rubricFile?.[0];

        if (!pdfFile) {
            return res.status(400).json({ error: 'PDF file is required' });
        }

        if (!rubricFile) {
            return res.status(400).json({ error: 'Rubric file is required' });
        }

        console.log('Processing files:', {
            pdf: pdfFile.originalname,
            rubric: rubricFile.originalname
        });

        const documentText = await extractTextFromFile(pdfFile);
        const rubricText = await extractTextFromFile(rubricFile);

        if (!documentText.trim()) {
            return res.status(400).json({ error: 'Could not extract text from PDF. Please ensure the PDF contains readable text.' });
        }

        if (!rubricText.trim()) {
            return res.status(400).json({ error: 'Could not extract text from rubric file. Please check the file format.' });
        }

        console.log('Calling Gemini API...');
        const result = await callGeminiAPI(documentText, rubricText, customInstructions);

        res.json({
            success: true,
            result: result,
            metadata: {
                documentLength: documentText.length,
                rubricLength: rubricText.length,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Analysis error:', error);
        res.status(500).json({ 
            error: error.message,
            success: false 
        });
    }
});

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        success: false 
    });
});

app.use((req, res) => {
    res.status(404).json({ 
        error: 'Endpoint not found',
        success: false 
    });
});

app.listen(PORT, () => {
    console.log(`PDF Grader Backend running on port ${PORT}`);
    console.log(`Gemini API Key configured: ${process.env.GEMINI_API_KEY ? 'Yes' : 'No'}`);
    console.log('Available endpoints:');
    console.log('  GET  / - API information');
    console.log('  POST /api/analyze - Analyze PDF with rubric');
});

module.exports = app;
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function extractTextFromFile(file, filename) {
    if (!file) {
        throw new Error('No file provided');
    }

    const buffer = Buffer.from(file, 'base64');
    const name = filename.toLowerCase();
    
    if (name.endsWith('.pdf')) {
        const data = await pdfParse(buffer);
        return data.text || 'Unable to extract text from PDF';
    } else if (name.endsWith('.docx')) {
        const result = await mammoth.extractRawText({ buffer });
        return result.value || 'Unable to extract text from DOCX';
    } else if (name.endsWith('.txt')) {
        return buffer.toString('utf8');
    } else {
        throw new Error('Unsupported file format. Please use PDF, DOCX, or TXT files.');
    }
}

async function callGeminiAPI(documentText, rubricText, customInstructions = '') {
    const apiKey = process.env.GEMINI_API_KEY || 'AIzaSyD4BNwOxdVcknsFoQ2nb1ehN7wnyaUy5Xg';
    
    if (!apiKey) {
        throw new Error('Gemini API key not configured');
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
    "feedback": "• Main strength of the document\\n• Key area that needs improvement\\n• Specific suggestion for enhancement\\n• Overall assessment in one sentence"
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
            
            if (feedbackMatch) {
                extractedFeedback = feedbackMatch[1].replace(/\\n/g, '\n');
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

exports.handler = async (event, context) => {
    // CORS headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    };

    // Handle preflight requests
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: ''
        };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const body = JSON.parse(event.body);
        const { pdfFile, rubricFile, customInstructions } = body;

        if (!pdfFile || !pdfFile.content || !pdfFile.filename) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'PDF file is required' })
            };
        }

        if (!rubricFile || !rubricFile.content || !rubricFile.filename) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Rubric file is required' })
            };
        }

        console.log('Processing files:', {
            pdf: pdfFile.filename,
            rubric: rubricFile.filename
        });

        const documentText = await extractTextFromFile(pdfFile.content, pdfFile.filename);
        const rubricText = await extractTextFromFile(rubricFile.content, rubricFile.filename);

        if (!documentText.trim()) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Could not extract text from PDF. Please ensure the PDF contains readable text.' })
            };
        }

        if (!rubricText.trim()) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Could not extract text from rubric file. Please check the file format.' })
            };
        }

        console.log('Calling Gemini API...');
        const result = await callGeminiAPI(documentText, rubricText, customInstructions);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                result: result,
                metadata: {
                    documentLength: documentText.length,
                    rubricLength: rubricText.length,
                    timestamp: new Date().toISOString()
                }
            })
        };

    } catch (error) {
        console.error('Analysis error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ 
                error: error.message,
                success: false 
            })
        };
    }
};
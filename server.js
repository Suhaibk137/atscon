const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, AlignmentType, LevelFormat } = require('docx');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const app = express();

// CORS Configuration - Allow your custom domain
const allowedOrigins = [
  'https://eliteresumes.in',
  'http://localhost:3000',
  'http://localhost:3001'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Server is running' });
});

// Main conversion endpoint
app.post('/api/convert', upload.single('resume'), async (req, res) => {
    try {
        const { apiKey } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        if (!apiKey) {
            return res.status(400).json({ error: 'API key is required' });
        }

        console.log(`Processing file: ${file.originalname}`);

        // Step 1: Extract text from the uploaded file
        let resumeText = '';
        
        if (file.mimetype === 'application/pdf') {
            const pdfData = await pdfParse(file.buffer);
            resumeText = pdfData.text;
        } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
                   file.mimetype === 'application/msword') {
            const result = await mammoth.extractRawText({ buffer: file.buffer });
            resumeText = result.value;
        } else if (file.mimetype === 'text/plain') {
            resumeText = file.buffer.toString('utf-8');
        } else {
            return res.status(400).json({ error: 'Unsupported file type' });
        }

        console.log('Text extracted successfully');

        const resumeData = await callClaudeAPI(apiKey, resumeText);
        console.log('Resume data structured successfully');

        const docBuffer = await generateWordDocument(resumeData);
        console.log('Word document generated successfully');

        res.set({
            'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'Content-Disposition': `attachment; filename="${file.originalname.replace(/\.[^/.]+$/, '')}_converted.docx"`
        });
        res.send(docBuffer);

    } catch (error) {
        console.error('Conversion error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Function to call Claude API
async function callClaudeAPI(apiKey, resumeText) {
    const fetch = (await import('node-fetch')).default;
    
    const prompt = `Convert the following resume to a specific template format. Extract ALL information and return it as a JSON object with this EXACT structure:

{
    "name": "FULL NAME IN CAPS",
    "location": "City, Country",
    "phone": "+XX XXXXXXXXXX",
    "email": "email@example.com",
    "summary": ["paragraph1", "paragraph2"],
    "experience": [
        {
            "title": "Job Title",
            "dates": "MMM YYYY – Present/MMM YYYY",
            "company": "Company Name, Location",
            "responsibilities": ["responsibility1", "responsibility2"]
        }
    ],
    "education": [
        {
            "degree": "Degree Name",
            "institution": "Institution Name, Location",
            "year": "YYYY or Pursuing"
        }
    ],
    "certifications": ["cert1", "cert2"],
    "skills": {
        "technical": "comma-separated skills",
        "core": "comma-separated competencies"
    },
    "achievements": ["achievement1", "achievement2"],
    "personal": {
        "nationality": "Country",
        "languages": "Language1 (Level), Language2 (Level)",
        "visaStatus": "Status if mentioned",
        "other": ["other detail 1", "other detail 2"]
    }
}

IMPORTANT RULES:
- Extract ALL information from the resume
- Convert name to ALL CAPS
- Keep professional summary in exactly 2 paragraphs
- Include ALL job experiences with ALL bullet points
- Preserve ALL dates and details exactly as mentioned
- If a section doesn't exist, use empty array or empty string
- Return ONLY the JSON object, no other text or markdown

Resume to convert:
${resumeText}`;

    const modelOptions = [
        'claude-3-haiku-20240307',
        'claude-3-sonnet-20240229',
        'claude-3-5-sonnet-20241022',
        'claude-3-opus-20240229'
    ];

    let lastError = null;

    for (const model of modelOptions) {
        try {
            console.log(`Trying model: ${model}`);
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: model,
                    max_tokens: 4000,
                    messages: [{
                        role: 'user',
                        content: prompt
                    }]
                })
            });

            if (response.ok) {
                const data = await response.json();
                const responseText = data.content[0].text;
                
                try {
                    return JSON.parse(responseText);
                } catch (e) {
                    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        return JSON.parse(jsonMatch[0]);
                    }
                    throw new Error('Failed to parse AI response as JSON');
                }
            } else {
                const errorText = await response.text();
                lastError = new Error(`Claude API error with model ${model}: ${response.status} - ${errorText}`);
                console.log(`Model ${model} failed: ${response.status}`);
                
                if (response.status !== 404) {
                    throw lastError;
                }
            }
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error('All Claude models failed. Please check your API key and model access.');
}

// Generate Word Document (unchanged)
async function generateWordDocument(data) {
    const doc = new Document({
        numbering: {
            config: [{
                reference: "bullet-list",
                levels: [{
                    level: 0,
                    format: LevelFormat.BULLET,
                    text: "•",
                    alignment: AlignmentType.LEFT,
                    style: {
                        paragraph: {
                            indent: { left: 720, hanging: 360 }
                        }
                    }
                }]
            }]
        },
        sections: [{
            properties: {
                page: {
                    margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
                }
            },
            children: [
                new Paragraph({
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 100 },
                    children: [
                        new TextRun({
                            text: data.name || "NAME",
                            size: 32,
                            bold: true
                        })
                    ]
                }),
                new Paragraph({
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 50 },
                    children: [
                        new TextRun({
                            text: `${data.location || "Location"}|${data.phone || "Phone"}`,
                            size: 22
                        })
                    ]
                }),
                new Paragraph({
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 200 },
                    children: [
                        new TextRun({
                            text: data.email || "email@example.com",
                            size: 22,
                            underline: {}
                        })
                    ]
                }),
                ...(data.summary || []).map((para, index) => 
                    new Paragraph({
                        alignment: AlignmentType.JUSTIFIED,
                        spacing: { after: index === data.summary.length - 1 ? 240 : 120 },
                        children: [
                            new TextRun({
                                text: para,
                                size: 22
                            })
                        ]
                    })
                ),
                new Paragraph({
                    spacing: { before: 120, after: 120 },
                    children: [
                        new TextRun({
                            text: "EXPERIENCE",
                            size: 24,
                            bold: true
                        })
                    ]
                }),
                ...(data.experience || []).flatMap((job, jobIndex) => [
                    new Paragraph({
                        spacing: { after: 60 },
                        children: [
                            new TextRun({ 
                                text: job.title || "Job Title", 
                                bold: true, 
                                size: 22 
                            }),
                            new TextRun({ 
                                text: `                                         ${job.dates || "Dates"}`, 
                                size: 22 
                            })
                        ]
                    }),
                    new Paragraph({
                        spacing: { after: 80 },
                        children: [
                            new TextRun({ 
                                text: job.company || "Company Name", 
                                size: 22 
                            })
                        ]
                    }),
                    ...(job.responsibilities || []).map((resp, respIndex) => 
                        new Paragraph({
                            numbering: { reference: "bullet-list", level: 0 },
                            spacing: { 
                                after: respIndex === job.responsibilities.length - 1 && 
                                       jobIndex < data.experience.length - 1 ? 120 : 60 
                            },
                            children: [
                                new TextRun({ 
                                    text: resp, 
                                    size: 22 
                                })
                            ]
                        })
                    )
                ]),
                new Paragraph({
                    spacing: { before: 120, after: 120 },
                    children: [
                        new TextRun({
                            text: "EDUCATION",
                            size: 24,
                            bold: true
                        })
                    ]
                }),
                ...(data.education || []).flatMap((edu, index) => [
                    new Paragraph({
                        spacing: { after: 60 },
                        children: [
                            new TextRun({ 
                                text: edu.degree || "Degree", 
                                bold: true, 
                                size: 22 
                            })
                        ]
                    }),
                    new Paragraph({
                        spacing: { after: index === data.education.length - 1 ? 180 : 120 },
                        children: [
                            new TextRun({ 
                                text: `${edu.institution || "Institution"} | ${edu.year || "Year"}`, 
                                size: 22 
                            })
                        ]
                    })
                ]),
                ...(data.certifications && data.certifications.length > 0 ? [
                    new Paragraph({
                        spacing: { before: 120, after: 120 },
                        children: [
                            new TextRun({
                                text: "CERTIFICATIONS",
                                size: 24,
                                bold: true
                            })
                        ]
                    }),
                    ...data.certifications.map((cert, index) => 
                        new Paragraph({
                            numbering: { reference: "bullet-list", level: 0 },
                            spacing: { after: index === data.certifications.length - 1 ? 180 : 60 },
                            children: [
                                new TextRun({ 
                                    text: cert, 
                                    size: 22 
                                })
                            ]
                        })
                    )
                ] : []),
                ...(data.achievements && data.achievements.length > 0 ? [
                    new Paragraph({
                        spacing: { before: 120, after: 120 },
                        children: [
                            new TextRun({
                                text: "KEY ACHIEVEMENTS",
                                size: 24,
                                bold: true
                            })
                        ]
                    }),
                    ...data.achievements.map((achievement, index) => 
                        new Paragraph({
                            numbering: { reference: "bullet-list", level: 0 },
                            spacing: { after: index === data.achievements.length - 1 ? 180 : 60 },
                            children: [
                                new TextRun({ 
                                    text: achievement, 
                                    size: 22 
                                })
                            ]
                        })
                    )
                ] : []),
                new Paragraph({
                    spacing: { before: 120, after: 120 },
                    children: [
                        new TextRun({
                            text: "SKILLS",
                            size: 24,
                            bold: true
                        })
                    ]
                }),
                new Paragraph({
                    alignment: AlignmentType.JUSTIFIED,
                    spacing: { after: 100 },
                    children: [
                        new TextRun({ 
                            text: "Technical skills: ", 
                            bold: true, 
                            size: 22 
                        }),
                        new TextRun({ 
                            text: data.skills?.technical || "Skills to be added", 
                            size: 22 
                        })
                    ]
                }),
                new Paragraph({
                    alignment: AlignmentType.JUSTIFIED,
                    spacing: { after: 180 },
                    children: [
                        new TextRun({ 
                            text: "Core competencies: ", 
                            bold: true, 
                            size: 22 
                        }),
                        new TextRun({ 
                            text: data.skills?.core || "Competencies to be added", 
                            size: 22 
                        })
                    ]
                }),
                new Paragraph({
                    spacing: { before: 120, after: 120 },
                    children: [
                        new TextRun({
                            text: "PERSONAL DETAILS",
                            size: 24,
                            bold: true
                        })
                    ]
                }),
                new Paragraph({
                    numbering: { reference: "bullet-list", level: 0 },
                    spacing: { after: 60 },
                    children: [
                        new TextRun({ 
                            text: `Nationality: ${data.personal?.nationality || "To be added"}`, 
                            size: 22 
                        })
                    ]
                }),
                ...(data.personal?.languages ? [
                    new Paragraph({
                        numbering: { reference: "bullet-list", level: 0 },
                        spacing: { after: 60 },
                        children: [
                            new TextRun({ 
                                text: `Languages: ${data.personal.languages}`, 
                                size: 22 
                            })
                        ]
                    })
                ] : []),
                ...(data.personal?.visaStatus ? [
                    new Paragraph({
                        numbering: { reference: "bullet-list", level: 0 },
                        spacing: { after: 60 },
                        children: [
                            new TextRun({ 
                                text: `Visa Status: ${data.personal.visaStatus}`, 
                                size: 22 
                            })
                        ]
                    })
                ] : []),
                ...(data.personal?.other || []).map((detail, index) => 
                    new Paragraph({
                        numbering: { reference: "bullet-list", level: 0 },
                        spacing: { after: 60 },
                        children: [
                            new TextRun({ 
                                text: detail, 
                                size: 22 
                            })
                        ]
                    })
                )
            ]
        }]
    });

    return await Packer.toBuffer(doc);
}

// Error handling for 404
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Export for Vercel
module.exports = app;
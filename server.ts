import express from "express";
import path from "path";
import multer from "multer";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import fs from "fs";

// Simple in-memory DB for prototype
let policies = [
  { id: "P1", name: "Data Privacy", description: "Documents must not contain un-redacted SSNs or sensitive PII.", type: "Privacy" },
  { id: "P2", name: "Financial Reporting", description: "Audit logs must contain transaction IDs and dates.", type: "Finance" },
  { id: "P3", name: "Contract Expiration", description: "Contracts must have a clearly stated valid-until or expiration date.", type: "Legal" }
];

let documents: any[] = [];
let violations: any[] = [];

// Base setup
function getAIClient() {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: { headers: { "User-Agent": "aistudio-build" } }
  });
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Configure multer (store files in memory just for the upload payload)
  const upload = multer({ storage: multer.memoryStorage() });

  // API Routes
  app.get("/api/stats", (req, res) => {
    // calculate stats
    const openV = violations.filter(v => v.status === "Open" || v.status === "In Review");
    const highV = violations.filter(v => (v.status === "Open" || v.status === "In Review") && v.severity === "High");
    const totalDocs = documents.length;
    
    // Fake formula for compliance: 100 - (open * 5) - (high * 10)
    let score = 100 - (openV.length * 5) - (highV.length * 10);
    if (score < 0) score = 0;
    if (documents.length === 0) score = 100;

    res.json({
      complianceScore: score,
      openViolations: openV.length,
      totalDocuments: totalDocs,
      criticalIssues: highV.length
    });
  });

  app.get("/api/policies", (req, res) => {
    res.json(policies);
  });

  app.get("/api/violations", (req, res) => {
    res.json(violations.sort((a,b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
  });

  app.patch("/api/violations/:id", (req, res) => {
    const v = violations.find(v => v.id === req.params.id);
    if (v) {
      v.status = req.body.status;
      res.json(v);
    } else {
      res.status(404).json({ error: "Not found" });
    }
  });

  app.get("/api/documents", (req, res) => {
    res.json(documents.sort((a,b) => new Date(b.uploadDate).getTime() - new Date(a.uploadDate).getTime()));
  });

  app.post("/api/documents", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const newDocId = `D${documents.length + 1}`;
      const doc = {
        id: newDocId,
        name: req.file.originalname,
        uploadDate: new Date().toISOString(),
        status: "Processing",
        department: req.body.department || "General"
      };
      documents.push(doc);

      // Return immediately so UI updates
      res.json(doc);

      // Async process document with Gemini
      const ai = getAIClient();
      const mimeType = req.file.mimetype;
      const base64Data = req.file.buffer.toString("base64");

      const policyContext = policies.map(p => `ID=${p.id}, Rule=${p.description}`).join("\n");
      const prompt = `Analyze this document against the following compliance policies:
${policyContext}
      
Determine if there are any violations. A violation happens if the document contradicts or fails to meet the obligations of a policy rule.
Provide a list of violations (if any) with their associated policyId, a description of why it failed, and a severity (Low, Medium, High).
If there are no violations, return an empty array for violations.`;

      const aiResponse = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: {
          parts: [
            { inlineData: { mimeType, data: base64Data } },
            { text: prompt }
          ]
        },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              violations: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    policyId: { type: Type.STRING },
                    description: { type: Type.STRING },
                    severity: { type: Type.STRING } // Low, Medium, High
                  }
                }
              }
            }
          }
        }
      });

      const result = JSON.parse(aiResponse.text || "{}");
      
      if (result.violations && result.violations.length > 0) {
        result.violations.forEach((v: any) => {
          violations.push({
            id: `V${violations.length + 1}`,
            documentId: doc.id,
            documentName: doc.name,
            description: v.description,
            severity: ["Low","Medium","High"].includes(v.severity) ? v.severity : "Medium",
            status: "Open",
            policyId: v.policyId,
            createdAt: new Date().toISOString()
          });
        });
      }

      // Update document status
      const storedDoc = documents.find(d => d.id === doc.id);
      if (storedDoc) storedDoc.status = "Processed";

    } catch (e: any) {
      console.error("Doc upload error:", e);
      // document might be stuck in "Processing", let's mark it as error if possible
      // res won't work as we already responded.
    }
  });


  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

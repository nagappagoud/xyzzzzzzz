import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// --- Types & Schemas ---

const ActionSchema = z.enum(['APPROVE', 'REJECT', 'FLAG', 'MODIFY']);

interface AgentResponse {
  score: number;
  reasoning: string;
  metadata?: any;
}

interface FinalDecision {
  action: string;
  confidence_score: number;
  explanation: string;
  suggested_modifications?: {
    removed?: string[];
    added?: string[];
    rider_instruction?: string;
  };
  agent_reports: {
    demand: AgentResponse;
    supply: AgentResponse;
    substitution?: any;
  };
}

// --- Agent Logic ---

class RealitySyncEngine {
  private model = genAI.getGenerativeModel({ 
    model: 'gemini-1.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
    }
  });

  async demandAuthenticityAgent(orderContext: any): Promise<AgentResponse> {
    const prompt = `
      Analyze this quick commerce order for fraud/spam: ${JSON.stringify(orderContext)}
      Consider:
      1. Quantity realism (e.g. 100 iPhone chargers at 3 AM is suspicious).
      2. Delivery location type (residential vs suspicious non-residential areas).
      3. User behavior (order frequency, cart consistency).
      4. Time of order.
      
      Output JSON with: "score" (0.0-1.0, 1.0 being authentic), "reasoning" (string), "is_anomaly" (boolean).
    `;

    const result = await this.model.generateContent(prompt);
    const text = result.response.text();
    return JSON.parse(text);
  }

  async supplyStabilityAgent(logisticsContext: any): Promise<AgentResponse> {
    const prompt = `
      Analyze delivery feasibility and risk: ${JSON.stringify(logisticsContext)}
      Consider:
      1. Macro events: protests, heavy rain, strikes, road closures.
      2. Micro events: traffic surges, historical 'blackhole' zones (areas with 70%+ failure).
      3. Resource availability: active riders nearby.
      
      Output JSON with: "score" (0.0-1.0, 1.0 being stable), "reasoning" (string), "risk_level" ("low"|"medium"|"high").
    `;

    const result = await this.model.generateContent(prompt);
    return JSON.parse(result.response.text());
  }

  async substitutionIntelAgent(cart: string[], outOfStockItem: string): Promise<any> {
    const prompt = `
      The item '${outOfStockItem}' is Out of Stock. 
      Analyze the user intent based on the rest of the cart: ${JSON.stringify(cart)}
      
      Example:
      - Cart: [Oatmeal, Sugar, Milk]. Intent: Breakfast. Substitute: Soy Milk or Almond Milk.
      - Cart: [Coffee, Cocoa Powder, Milk]. Intent: Baking/Mocha. Substitute: Condensed Milk or Cream.
      
      Output JSON with: "suggested_item" (string), "intent_analysis" (string), "confidence" (number 0-1).
    `;

    const result = await this.model.generateContent(prompt);
    return JSON.parse(result.response.text());
  }

  async orchestrateDecision(data: any): Promise<FinalDecision> {
    const { user_order, logistics, oos_item } = data;

    // 1. Run Domain Agents in parallel
    const [demandRes, supplyRes] = await Promise.all([
      this.demandAuthenticityAgent(user_order),
      this.supplyStabilityAgent(logistics)
    ]);

    let subRes = null;
    if (oos_item) {
      subRes = await this.substitutionIntelAgent(user_order.cart, oos_item);
    }

    // 2. The Decision Brain (Synthesis)
    const synthesisPrompt = `
      You are the Decision Brain of RealitySync Engine. Synthesize these reports:
      - Demand Authenticity: ${JSON.stringify(demandRes)}
      - Supply Stability: ${JSON.stringify(supplyRes)}
      - Substitution Analysis: ${JSON.stringify(subRes)}

      Decision Logic:
      - If Demand score < 0.4: REJECT (Potential Spam/Fraud).
      - If Supply score < 0.3: REJECT (Hazardous/Impossible).
      - If Supply score < 0.6: FLAG (Rider warning needed).
      - If Substitution suggested: MODIFY.
      - Otherwise: APPROVE.

      Output JSON format:
      {
        "action": "APPROVE" | "REJECT" | "FLAG" | "MODIFY",
        "confidence_score": number (0-1),
        "explanation": "Brief reasoning explaining the synergy of factors",
        "suggested_modifications": {
          "removed": ["item_name"],
          "added": ["item_name"],
          "rider_instruction": "string"
        }
      }
    `;

    const result = await this.model.generateContent(synthesisPrompt);
    const decision = JSON.parse(result.response.text());

    return {
      ...decision,
      agent_reports: {
        demand: demandRes,
        supply: supplyRes,
        substitution: subRes
      }
    };
  }
}

// --- Server Setup ---

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  const engine = new RealitySyncEngine();

  // API Route
  app.post('/api/sync-order', async (req, res) => {
    try {
      const decision = await engine.orchestrateDecision(req.body);
      res.json(decision);
    } catch (error: any) {
      console.error('Engine Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Vite Integration
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`RealitySync Engine running at http://localhost:${PORT}`);
  });
}

startServer();

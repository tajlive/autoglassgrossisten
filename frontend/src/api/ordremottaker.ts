import type { Product } from '@/types/api';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

export class OrdremottakerError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = 'OrdremottakerError';
  }
}

export interface AccessoryItem {
  sku: string;
  name: string;
  price: number;
  included: boolean;
  removable: boolean;
  category?: 'required' | 'recommended' | 'warning';
  notes?: string;
}

export interface ProactiveSuggestionItem {
  sku: string;
  name: string;
  lastOrdered: string;
  qty: number;
  product?: Product;
}

export interface ProactiveSuggestion {
  type: 'last_order' | 'frequent_item' | 'reorder_prompt';
  message: string;
  items: ProactiveSuggestionItem[];
}

export interface MatchExplanation {
  layer: number;
  layerName: string;
  confidence: 'exact' | 'high' | 'medium' | 'low' | 'none';
  reasons: string[];
  vehicle?: {
    make: string;
    model: string;
    year: number;
    regnr?: string;
  };
}

export interface QuoteDraftProduct {
  id: number;
  supplier_sku?: string;
  article_number?: string | null;
  eurocode: string | null;
  brand: string;
  model: string | null;
  category: string;
  description: string;
  price: number | null;
}

export interface QuoteDraftItem {
  product: QuoteDraftProduct;
  qty: number;
  accessories: AccessoryItem[];
}

export interface QuoteDraft {
  items: QuoteDraftItem[];
  subtotal: number;
  accessoryTotal: number;
  total: number;
  notes?: string;
}

export interface HandoffSummary {
  reason: 'no_match' | 'low_confidence' | 'multiple_vehicles' | 'customer_request' | 'equipment_unclear';
  summary: string;
  sessionToken?: string;
}

export interface UnifiedSearchToolData {
  searchResult?: {
    ok: boolean;
    error?: { code?: string; message: string };
    results?: Product[];
    confidence?: {
      level: MatchExplanation['confidence'];
      score: number;
      layer: number;
      reasons: string[];
    };
  };
  matchExplanation?: MatchExplanation;
}

export interface ToolResult {
  tool: 'search' | 'faq' | 'buildQuote' | 'handoff' | string;
  id: string;
  success: boolean;
  data?: UnifiedSearchToolData | QuoteDraft | HandoffSummary | Record<string, unknown> | null;
  error?: string;
}

export interface OrdremottakerResponse {
  status: 'question' | 'recommendation' | 'order_ready' | 'escalated' | 'clarification' | 'knowledge';
  ai_response: string;
  session_token: string;
  candidates?: Product[];
  accessories?: AccessoryItem[];
  cart_url?: string;
  confidence: number;
  next_action?: string;
  proactive_suggestions?: ProactiveSuggestion[];
  tool_results?: ToolResult[];
}

export interface FeedbackPayload {
  session_token: string;
  position: string;
  recommended_eurocode: string | null;
  chosen_eurocode?: string;
  was_correct: 1 | 0 | -1;
  equipment_answers: Record<string, string>;
}

export async function sendMessage(
  message: string,
  sessionToken?: string,
  customerId?: number,
  image?: string
): Promise<OrdremottakerResponse> {
  const res = await fetch(`${API_BASE}/api/ordremottaker`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      session_token: sessionToken,
      customer_id: customerId,
      channel: 'chat',
      language: 'no',
      image,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new OrdremottakerError(body.error || `Feil (${res.status})`, res.status);
  }

  return res.json();
}

export async function sendFeedback(payload: FeedbackPayload): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/api/ordremottaker/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new OrdremottakerError(body.error || `Feil (${res.status})`, res.status);
  }

  return res.json();
}

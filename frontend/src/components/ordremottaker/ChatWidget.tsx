import { useState, useRef, useEffect } from 'react';
import { MessageCircle, X, Send, Loader2, RotateCcw, Check, XCircle, HelpCircle, Camera } from 'lucide-react';
import { useOrdremottaker } from '@/hooks/useOrdremottaker';
import { useChatStore } from '@/stores/chatStore';
import ChatMessage from './ChatMessage';
import GlassSuggestion from './GlassSuggestion';
import AccessorySelector from './AccessorySelector';
import ProactiveSuggestions from './ProactiveSuggestions';
import ProfessorAvatar from './ProfessorAvatar';
import ToolResultsPanel from './ToolResultsPanel';

const EXAMPLE_PROMPTS = [
  'Jeg har en VW Transporter 2019 som trenger ny frontrute',
  'Har dere siderute til Audi A4 2015?',
  'Jeg trenger bakrute med varme til Volvo XC60',
];

// ── Hierarchical Position Wizard ──
// Step 1: Choose main category
// Step 2 (for door/side): Choose side (driver/passenger)
// Step 3 (for door/side): Choose front/back

interface PositionStep {
  label: string;
  value: string;
}

const POSITION_CATEGORIES: PositionStep[] = [
  { label: 'Frontrute', value: 'frontrute' },
  { label: 'Bakrute', value: 'bakrute' },
  { label: 'Dørrute', value: 'dørrute' },
  { label: 'Siderute', value: 'siderute' },
  { label: 'Ventilrute', value: 'ventilrute' },
  { label: 'Annet', value: 'annet' },
];

const SIDE_OPTIONS: PositionStep[] = [
  { label: 'Førerside', value: 'fv' },
  { label: 'Passasjerside', value: 'fh' },
];

const PLACEMENT_OPTIONS: PositionStep[] = [
  { label: 'Foran', value: 'foran' },
  { label: 'Bak', value: 'bak' },
];

// For dørrute/siderute: side (fv/fh) + placement (foran/bak) → final code
// fv + foran = fv, fv + bak = bv
// fh + foran = fh, fh + bak = bh
function getFinalSideCode(side: string, placement: string): string {
  if (side === 'fv') return placement === 'bak' ? 'bv' : 'fv';
  if (side === 'fh') return placement === 'bak' ? 'bh' : 'fh';
  return side;
}

// MVP: hardcoded customer ID until real auth is implemented
const MVP_CUSTOMER_ID = 1;

export default function ChatWidget() {
  const { isOpen, initialMessage, initialRegnr, openChat, closeChat, clearInitial } = useChatStore();
  const [input, setInput] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sendingImage, setSendingImage] = useState(false);
  const [feedbackState, setFeedbackState] = useState<'idle' | 'wrong' | 'submitted'>('idle');
  const [correctEurocode, setCorrectEurocode] = useState('');
  const [otherPosition, setOtherPosition] = useState('');
  // Position wizard state
  const [positionWizard, setPositionWizard] = useState<{
    step: 'category' | 'side' | 'placement' | 'other';
    category?: string;
    side?: string;
  }>({ step: 'category' });
  const {
    messages,
    proactiveSuggestions,
    sessionToken,
    equipmentAnswers,
    sendUserMessage,
    init,
    isLoading,
    error,
    reset,
    sendFeedback,
    isFeedbackLoading,
    recordEquipmentAnswer,
  } = useOrdremottaker();
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close on Escape + trap Tab focus inside the panel
  useEffect(() => {
    if (!isOpen) return;

    const panel = panelRef.current;
    if (!panel) return;

    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);

    // Focus first usable element (input if available, otherwise first button)
    const input = focusables.find((el) => el.tagName === 'INPUT');
    (input ?? focusables[0])?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeChat();
        return;
      }

      if (e.key !== 'Tab' || focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeChat]);

  // Return focus to the floating trigger when closed
  useEffect(() => {
    if (!isOpen) {
      triggerRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading, isOpen, feedbackState]);

  // Handle chat open: send initial message/regnr or init proactive suggestions
  useEffect(() => {
    if (!isOpen || messages.length > 0) return;

    if (initialMessage) {
      sendUserMessage(initialMessage, MVP_CUSTOMER_ID);
      clearInitial();
    } else if (initialRegnr) {
      sendUserMessage(initialRegnr, MVP_CUSTOMER_ID);
      clearInitial();
    } else if (!proactiveSuggestions && !isLoading) {
      init(MVP_CUSTOMER_ID);
    }
  }, [isOpen, messages.length, initialMessage, initialRegnr, proactiveSuggestions, isLoading, init, sendUserMessage, clearInitial]);

  // Reset feedback and other-position state when a new AI message arrives
  useEffect(() => {
    setFeedbackState('idle');
    setCorrectEurocode('');
    setPositionWizard({ step: 'category' });
    setOtherPosition('');
  }, [messages.length]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput('');
    sendUserMessage(text, MVP_CUSTOMER_ID);
  };

  // Foto av 43R-merke eller kjennemerke → sendes som dataURL (bildet lagres aldri server-side).
  const handleImageSend = (file: File) => {
    if (!file.type.startsWith('image/')) return;
    if (file.size > 5 * 1024 * 1024) {
      setInput('Bildet er over 5 MB — ta et nytt bilde med mobilen.');
      return;
    }
    const leser = new FileReader();
    setSendingImage(true);
    leser.onload = () => {
      setSendingImage(false);
      sendUserMessage('Jeg sender et bilde av glasset', MVP_CUSTOMER_ID, String(leser.result));
    };
    leser.onerror = () => setSendingImage(false);
    leser.readAsDataURL(file);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSend();
  };

  const handleEquipmentAnswer = (answer: string) => {
    const lastAiMsg = [...messages].reverse().find((m) => m.role === 'ai');
    if (!lastAiMsg?.nextAction) return;
    // Only record for rigid equipment questions, not LLM-managed questions
    if (lastAiMsg.nextAction !== 'ask_llm') {
      recordEquipmentAnswer(lastAiMsg.nextAction, answer);
    }
    sendUserMessage(answer, MVP_CUSTOMER_ID);
  };

  const lastAiMessage = [...messages].reverse().find((m) => m.role === 'ai');
  const isAskingEquipment = (lastAiMessage?.nextAction?.startsWith('ask_') &&
    lastAiMessage?.nextAction !== 'ask_llm' &&
    lastAiMessage?.nextAction !== 'ask_position' &&
    lastAiMessage?.nextAction !== 'ask_vehicle_details') || false;
  const isAskingPosition = lastAiMessage?.nextAction === 'ask_position';

  const handlePositionAnswer = (value: string) => {
    if (value === 'annet') {
      setPositionWizard({ step: 'other' });
      return;
    }
    setOtherPosition('');
    sendUserMessage(value, MVP_CUSTOMER_ID);
    // Reset wizard for next time
    setPositionWizard({ step: 'category' });
  };

  const handleCategorySelect = (category: string) => {
    if (category === 'annet') {
      setPositionWizard({ step: 'other' });
      return;
    }
    if (category === 'dørrute' || category === 'siderute') {
      setPositionWizard({ step: 'side', category });
    } else {
      // Frontrute, bakrute, ventilrute — final answer
      handlePositionAnswer(category);
    }
  };

  const handleSideSelect = (side: string) => {
    setPositionWizard((prev) => ({ ...prev, step: 'placement', side }));
  };

  const handlePlacementSelect = (placement: string) => {
    const { category, side } = positionWizard;
    if (!category || !side) return;
    const finalSide = getFinalSideCode(side, placement);
    const finalValue = category === 'dørrute'
      ? `dørrute-${finalSide}`
      : `sideglass-${finalSide}`;
    handlePositionAnswer(finalValue);
  };

  const handleWizardBack = () => {
    setPositionWizard((prev) => {
      if (prev.step === 'placement') return { step: 'side', category: prev.category };
      if (prev.step === 'side') return { step: 'category' };
      return { step: 'category' };
    });
  };

  const handleOtherPositionSubmit = () => {
    const text = otherPosition.trim();
    if (!text) return;
    setPositionWizard({ step: 'category' });
    setOtherPosition('');
    sendUserMessage(text, MVP_CUSTOMER_ID);
  };
  const isShowingRecommendation =
    lastAiMessage?.status === 'recommendation' &&
    lastAiMessage.candidates &&
    lastAiMessage.candidates.length > 0;

  const handleFeedback = async (wasCorrect: 1 | 0 | -1) => {
    if (!lastAiMessage?.candidates || lastAiMessage.candidates.length === 0 || !sessionToken) return;

    const recommended = lastAiMessage.candidates[0];
    const payload = {
      session_token: sessionToken,
      position: recommended.typeCodeDesc || recommended.typeCode || '',
      recommended_eurocode: recommended.eurocode,
      chosen_eurocode: wasCorrect === 0 ? correctEurocode : undefined,
      was_correct: wasCorrect,
      equipment_answers: equipmentAnswers,
    };

    await sendFeedback(payload);
    setFeedbackState('submitted');
  };

  const handleWrongGlass = () => {
    setFeedbackState('wrong');
  };

  const handleSubmitWrongGlass = async () => {
    await handleFeedback(0);
  };

  const handleReset = () => {
    reset();
    setPositionWizard({ step: 'category' });
    setOtherPosition('');
    setFeedbackState('idle');
    setCorrectEurocode('');
  };

  return (
    <>
      {/* Floating button */}
      <button
        ref={triggerRef}
        onClick={() => (isOpen ? closeChat() : openChat())}
        tabIndex={isOpen ? -1 : 0}
        aria-hidden={isOpen}
        className="fixed bottom-6 right-6 z-50 flex h-12 w-12 md:h-14 md:w-14 items-center justify-center rounded-full bg-autoglass-blue text-white shadow-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-autoglass-blue focus-visible:ring-offset-2"
        aria-label={isOpen ? 'Lukk chat' : 'Åpne chat'}
      >
        {isOpen ? <X className="h-6 w-6" /> : <MessageCircle className="h-6 w-6" />}
      </button>

      {/* Chat window */}
      {isOpen && (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Chat med Professor Autoglass"
          className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-white animate-fade-in md:bottom-8 md:right-8 md:left-auto md:top-auto md:w-[480px] md:rounded-3xl md:border md:border-gray-200 md:shadow-2xl md:h-[700px] md:max-h-[90vh]"
        >
          {/* Header */}
          <div className="flex items-center justify-between bg-autoglass-blue px-4 py-3 text-white shrink-0">
            <div className="flex items-center gap-3">
              <ProfessorAvatar size="sm" />
              <div>
                <h3 className="text-base md:text-sm font-semibold">Professor Autoglass</h3>
                <p className="text-xs text-white/70">Din bilglass-ekspert</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={handleReset}
                className="rounded p-2 md:p-1 transition-colors hover:bg-white/20 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center"
                title="Ny chat"
                aria-label="Ny chat"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
              <button
                onClick={closeChat}
                className="rounded p-2 md:p-1 transition-colors hover:bg-white/20 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center"
                title="Lukk"
                aria-label="Lukk"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 md:max-h-[480px] md:min-h-[360px]">
            {messages.length === 0 && (
              <div className="space-y-6 md:space-y-4">
                <div className="flex flex-col items-center gap-3 text-center">
                  <ProfessorAvatar size="lg" />
                  <div>
                    <p className="text-lg md:text-base font-semibold text-gray-800">
                      Hei! Jeg er Professor Autoglass
                    </p>
                    <p className="text-base md:text-sm text-gray-500 mt-1">
                      Din ekspert på bilglass med 30 års erfaring. <br/>
                      Fortell meg hva du trenger — regnr, merke/modell, eller eurocode.
                    </p>
                  </div>
                </div>
                <div className="space-y-2">
                  {EXAMPLE_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => {
                        setInput('');
                        sendUserMessage(prompt, MVP_CUSTOMER_ID);
                      }}
                      className="w-full rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 md:px-3 md:py-2 text-left text-base md:text-sm text-gray-700 transition-colors hover:border-autoglass-blue hover:bg-autoglass-light hover:text-autoglass-blue min-h-[44px]"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Proactive suggestions shown above first AI response when available */}
            {messages.length === 0 && proactiveSuggestions && proactiveSuggestions.length > 0 && (
              <ProactiveSuggestions suggestions={proactiveSuggestions} />
            )}

            {messages.map((msg, idx) => {
              const isLastMessage = idx === messages.length - 1;
              return (
                <div key={msg.id}>
                  <ChatMessage
                    role={msg.role}
                    content={msg.content}
                    candidates={msg.candidates}
                    accessories={msg.accessories}
                    cartUrl={msg.cartUrl}
                  />
                  {msg.role === 'ai' && (
                    <ToolResultsPanel results={msg.toolResults} />
                  )}
                  {msg.role === 'ai' && msg.status === 'recommendation' && msg.candidates && msg.candidates.length > 0 && (
                    <GlassSuggestion candidates={msg.candidates} />
                  )}
                  {msg.role === 'ai' && (msg.status === 'recommendation' || msg.status === 'order_ready') && msg.accessories && msg.accessories.length > 0 && (
                    <AccessorySelector accessories={msg.accessories} />
                  )}

                  {/* Position question buttons — Hierarchical Wizard */}
                  {isLastMessage && msg.role === 'ai' && msg.status === 'question' && isAskingPosition && (
                    <div className="mb-4 mt-2 flex flex-col gap-3">
                      {/* Step 1: Choose main category */}
                      {positionWizard.step === 'category' && (
                        <>
                          <p className="text-sm text-gray-500">Velg glass:</p>
                          <div className="grid grid-cols-2 gap-2">
                            {POSITION_CATEGORIES.map((opt) => (
                              <button
                                key={opt.value}
                                onClick={() => handleCategorySelect(opt.value)}
                                disabled={isLoading}
                                className={`min-h-[64px] rounded-xl px-3 py-3 text-center text-base font-medium transition-colors disabled:opacity-50 active:scale-[0.98] ${
                                  opt.value === 'annet'
                                    ? 'border-2 border-dashed border-gray-300 bg-white text-gray-600 hover:border-autoglass-blue hover:text-autoglass-blue'
                                    : 'bg-white border border-gray-200 text-gray-800 hover:border-autoglass-blue hover:bg-autoglass-light hover:text-autoglass-blue shadow-sm'
                                }`}
                              >
                                <span className="block">{opt.label}</span>
                              </button>
                            ))}
                          </div>
                        </>
                      )}

                      {/* Step 2: Choose side (driver/passenger) */}
                      {positionWizard.step === 'side' && positionWizard.category && (
                        <>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={handleWizardBack}
                              className="text-sm text-gray-400 hover:text-autoglass-blue transition-colors"
                            >
                              ← Tilbake
                            </button>
                            <p className="text-sm text-gray-500">
                              {POSITION_CATEGORIES.find(c => c.value === positionWizard.category)?.label} — Velg side:
                            </p>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            {SIDE_OPTIONS.map((opt) => (
                              <button
                                key={opt.value}
                                onClick={() => handleSideSelect(opt.value)}
                                disabled={isLoading}
                                className="min-h-[64px] rounded-xl bg-white border border-gray-200 px-3 py-3 text-center text-base font-medium text-gray-800 transition-colors hover:border-autoglass-blue hover:bg-autoglass-light hover:text-autoglass-blue shadow-sm disabled:opacity-50 active:scale-[0.98]"
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        </>
                      )}

                      {/* Step 3: Choose front/back */}
                      {positionWizard.step === 'placement' && positionWizard.category && positionWizard.side && (
                        <>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={handleWizardBack}
                              className="text-sm text-gray-400 hover:text-autoglass-blue transition-colors"
                            >
                              ← Tilbake
                            </button>
                            <p className="text-sm text-gray-500">
                              {POSITION_CATEGORIES.find(c => c.value === positionWizard.category)?.label},{' '}
                              {SIDE_OPTIONS.find(s => s.value === positionWizard.side)?.label} — Foran eller bak?
                            </p>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            {PLACEMENT_OPTIONS.map((opt) => (
                              <button
                                key={opt.value}
                                onClick={() => handlePlacementSelect(opt.value)}
                                disabled={isLoading}
                                className="min-h-[64px] rounded-xl bg-white border border-gray-200 px-3 py-3 text-center text-base font-medium text-gray-800 transition-colors hover:border-autoglass-blue hover:bg-autoglass-light hover:text-autoglass-blue shadow-sm disabled:opacity-50 active:scale-[0.98]"
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        </>
                      )}

                      {/* Other / Annet */}
                      {positionWizard.step === 'other' && (
                        <div className="flex flex-col gap-2 rounded-xl border border-autoglass-blue bg-autoglass-light p-3">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={handleWizardBack}
                              className="text-sm text-autoglass-blue hover:underline"
                            >
                              ← Tilbake
                            </button>
                            <p className="text-sm text-autoglass-blue">Beskriv glasset:</p>
                          </div>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={otherPosition}
                              onChange={(e) => setOtherPosition(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && handleOtherPositionSubmit()}
                              placeholder="F.eks. takluke, soltak..."
                              className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-base outline-none focus:border-autoglass-blue"
                              autoFocus
                            />
                            <button
                              onClick={handleOtherPositionSubmit}
                              disabled={!otherPosition.trim() || isLoading}
                              className="rounded-lg bg-autoglass-blue px-4 py-2 text-white font-medium disabled:opacity-50"
                            >
                              Send
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Equipment question buttons — only on last AI message when status is 'question' */}
                  {isLastMessage && msg.role === 'ai' && msg.status === 'question' && isAskingEquipment && !isAskingPosition && (
                    <div className="mb-4 mt-2 flex flex-col gap-2">
                      <p className="text-sm text-gray-500">Velg et alternativ:</p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => handleEquipmentAnswer('Ja')}
                          disabled={isLoading}
                          className="flex-1 min-h-[48px] rounded-xl bg-green-500 px-4 py-3 text-base font-semibold text-white transition-colors hover:bg-green-600 disabled:opacity-50 active:scale-[0.98]"
                        >
                          Ja
                        </button>
                        <button
                          onClick={() => handleEquipmentAnswer('Nei')}
                          disabled={isLoading}
                          className="flex-1 min-h-[48px] rounded-xl bg-gray-500 px-4 py-3 text-base font-semibold text-white transition-colors hover:bg-gray-600 disabled:opacity-50 active:scale-[0.98]"
                        >
                          Nei
                        </button>
                        <button
                          onClick={() => handleEquipmentAnswer('Vet ikke')}
                          disabled={isLoading}
                          className="flex-1 min-h-[48px] rounded-xl border-2 border-autoglass-blue bg-white px-4 py-3 text-base font-semibold text-autoglass-blue transition-colors hover:bg-autoglass-light disabled:opacity-50 active:scale-[0.98]"
                        >
                          Vet ikke
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Feedback UI — only on last AI message when showing recommendations */}
                  {isLastMessage && msg.role === 'ai' && isShowingRecommendation && feedbackState !== 'submitted' && (
                    <div className="mb-4 mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
                      <p className="mb-3 text-base font-medium text-gray-700">
                        Var dette riktig glass?
                      </p>
                      {feedbackState === 'idle' ? (
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => handleFeedback(1)}
                            disabled={isFeedbackLoading}
                            className="flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-xl bg-green-500 px-4 py-3 text-base font-semibold text-white transition-colors hover:bg-green-600 disabled:opacity-50 active:scale-[0.98]"
                          >
                            <Check className="h-5 w-5" />
                            Riktig
                          </button>
                          <button
                            onClick={handleWrongGlass}
                            disabled={isFeedbackLoading}
                            className="flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-xl bg-red-500 px-4 py-3 text-base font-semibold text-white transition-colors hover:bg-red-600 disabled:opacity-50 active:scale-[0.98]"
                          >
                            <XCircle className="h-5 w-5" />
                            Feil glass
                          </button>
                          <button
                            onClick={() => handleFeedback(-1)}
                            disabled={isFeedbackLoading}
                            className="flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-xl border-2 border-gray-300 bg-white px-4 py-3 text-base font-semibold text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-50 active:scale-[0.98]"
                          >
                            <HelpCircle className="h-5 w-5" />
                            Usikker
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <p className="text-sm text-gray-600">
                            Skriv inn riktig eurocode (valgfritt):
                          </p>
                          <input
                            type="text"
                            value={correctEurocode}
                            onChange={(e) => setCorrectEurocode(e.target.value)}
                            placeholder="Eurocode..."
                            className="w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-base text-gray-800 placeholder-gray-400 outline-none focus:border-autoglass-blue focus:ring-1 focus:ring-autoglass-blue min-h-[44px]"
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={handleSubmitWrongGlass}
                              disabled={isFeedbackLoading}
                              className="flex-1 min-h-[48px] rounded-xl bg-autoglass-blue px-4 py-3 text-base font-semibold text-white transition-colors hover:bg-autoglass-dark disabled:opacity-50 active:scale-[0.98]"
                            >
                              Send tilbakemelding
                            </button>
                            <button
                              onClick={() => setFeedbackState('idle')}
                              disabled={isFeedbackLoading}
                              className="min-h-[48px] rounded-xl border-2 border-gray-300 bg-white px-4 py-3 text-base font-semibold text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-50 active:scale-[0.98]"
                            >
                              Avbryt
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {isLastMessage && msg.role === 'ai' && isShowingRecommendation && feedbackState === 'submitted' && (
                    <div className="mb-4 mt-2 rounded-xl bg-green-50 px-4 py-3 text-center text-base font-medium text-green-700">
                      Takk for tilbakemeldingen!
                    </div>
                  )}
                </div>
              );
            })}

            {isLoading && (
              <div className="flex items-start gap-3 py-3 md:py-2 text-base md:text-sm text-gray-500">
                <ProfessorAvatar size="sm" className="shrink-0 mt-0.5" />
                <div className="flex items-center gap-2 bg-gray-50 rounded-2xl rounded-tl-sm px-4 py-3">
                  <Loader2 className="h-4 w-4 animate-spin text-autoglass-blue" />
                  <span>Professor Autoglass tenker...</span>
                </div>
              </div>
            )}

            {error && (
              <div className="mt-2 rounded-lg bg-red-50 px-4 py-3 md:px-3 md:py-2 text-base md:text-sm text-red-600">
                {error instanceof Error ? error.message : 'Noe gikk galt. Prøv igjen.'}
              </div>
            )}
          </div>

          {/* Input */}
          <div className="flex items-center gap-2 border-t border-gray-100 px-4 py-4 md:px-3 md:py-3 shrink-0">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading || sendingImage}
              title="Send bilde av 43R-merket på glasset eller kjennemerket"
              className="flex h-11 w-11 md:h-9 md:w-9 items-center justify-center rounded-lg border-2 border-dashed border-gray-300 text-gray-500 transition-colors hover:border-autoglass-blue hover:text-autoglass-blue hover:bg-autoglass-light disabled:opacity-40 shrink-0"
              aria-label="Send bilde av glasset eller kjennemerket"
            >
              <Camera className="h-5 w-5 md:h-4 md:w-4" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) handleImageSend(f);
              }}
            />
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={sendingImage ? 'Leser bildet…' : 'Skriv en melding…'}
              className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 md:px-3 md:py-2 text-base md:text-sm text-gray-800 placeholder-gray-400 outline-none focus:border-autoglass-blue focus:ring-1 focus:ring-autoglass-blue min-h-[44px]"
              disabled={isLoading || sendingImage}
            />
            <button
              onClick={handleSend}
              disabled={(!input.trim() && !sendingImage) || isLoading}
              className="flex h-11 w-11 md:h-9 md:w-9 items-center justify-center rounded-lg bg-autoglass-blue text-white transition-colors hover:bg-autoglass-dark disabled:opacity-40 shrink-0"
              aria-label="Send"
            >
              {isLoading || sendingImage ? (
                <Loader2 className="h-5 w-5 md:h-4 md:w-4 animate-spin" />
              ) : (
                <Send className="h-5 w-5 md:h-4 md:w-4" />
              )}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

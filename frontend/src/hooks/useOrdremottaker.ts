import { useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { sendMessage, sendFeedback, type OrdremottakerResponse, type ProactiveSuggestion, type FeedbackPayload } from '@/api/ordremottaker';

interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  content: string;
  candidates?: OrdremottakerResponse['candidates'];
  accessories?: OrdremottakerResponse['accessories'];
  cartUrl?: string;
  status?: OrdremottakerResponse['status'];
  nextAction?: OrdremottakerResponse['next_action'];
  toolResults?: OrdremottakerResponse['tool_results'];
  timestamp: number;
}

export function useOrdremottaker() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionToken, setSessionToken] = useState<string>('');
  const [proactiveSuggestions, setProactiveSuggestions] = useState<ProactiveSuggestion[] | undefined>();
  const [equipmentAnswers, setEquipmentAnswers] = useState<Record<string, string>>({});

  const mutation = useMutation({
    mutationFn: async ({ message, customerId, image }: { message: string; customerId?: number; image?: string }) => {
      const response = await sendMessage(message, sessionToken || undefined, customerId, image);
      if (response.session_token) setSessionToken(response.session_token);
      return response;
    },
    onSuccess: (response) => {
      if (response.proactive_suggestions) {
        setProactiveSuggestions(response.proactive_suggestions);
      }
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'ai',
          content: response.ai_response,
          candidates: response.candidates,
          accessories: response.accessories,
          cartUrl: response.cart_url,
          status: response.status,
          nextAction: response.next_action,
          toolResults: response.tool_results,
          timestamp: Date.now(),
        },
      ]);
    },
  });

  const feedbackMutation = useMutation({
    mutationFn: async (payload: FeedbackPayload) => {
      return sendFeedback(payload);
    },
  });

  const init = useCallback(
    (customerId?: number) => {
      // Send a hidden init message to fetch proactive suggestions
      // without showing a user message bubble
      mutation.mutate({ message: 'Hei', customerId });
    },
    [mutation]
  );

  const sendUserMessage = useCallback(
    (text: string, customerId?: number, image?: string) => {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'user',
          content: image ? `${text || '📷'}` : text,
          timestamp: Date.now(),
        },
      ]);
      mutation.mutate({ message: text, customerId, image });
    },
    [mutation]
  );

  const recordEquipmentAnswer = useCallback((question: string, answer: string) => {
    setEquipmentAnswers((prev) => ({ ...prev, [question]: answer }));
  }, []);

  const reset = useCallback(() => {
    setMessages([]);
    setSessionToken('');
    setProactiveSuggestions(undefined);
    setEquipmentAnswers({});
  }, []);

  return {
    messages,
    proactiveSuggestions,
    sessionToken,
    equipmentAnswers,
    sendUserMessage,
    init,
    isLoading: mutation.isPending,
    error: mutation.error,
    reset,
    sendFeedback: feedbackMutation.mutateAsync,
    isFeedbackLoading: feedbackMutation.isPending,
    recordEquipmentAnswer,
  };
}

import { create } from 'zustand';

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'win' | 'warn';
}

export const useToasts = create<{ toasts: Toast[]; push(text: string, tone?: Toast['tone']): void }>((set) => ({
  toasts: [],
  push: (text, tone = 'info') => {
    const id = Date.now() + Math.random();
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone }] }));
    window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 2600);
  },
}));

export const toast = (text: string, tone?: Toast['tone']) => useToasts.getState().push(text, tone);

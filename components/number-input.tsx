'use client';

import { useState, type ComponentProps } from 'react';
import { Input } from '@/components/ui/input';

type Props = Omit<ComponentProps<typeof Input>, 'value' | 'defaultValue' | 'onChange' | 'type'> & {
  value: number;
  onValueChange: (value: number) => void;
};

/** Keep the editing text (including blank) separate from the validated number. */
export function NumberInput({ value, onValueChange, ...props }: Props) {
  const [draft, setDraft] = useState(() => ({ value, text: Number.isFinite(value) ? String(value) : '' }));
  if (!Object.is(draft.value, value)) {
    setDraft({ value, text: Number.isFinite(value) ? String(value) : '' });
  }
  return <Input {...props} type="number" value={draft.text} onChange={event => {
    const next = event.currentTarget.valueAsNumber;
    setDraft({ value: next, text: event.currentTarget.value });
    onValueChange(next);
  }} />;
}

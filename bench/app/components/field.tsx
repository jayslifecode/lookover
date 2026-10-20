import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { CONTROL } from './styles';

interface FieldFrameProps {
  id: string;
  /** The `<label for>` text, exactly: hints and errors are separate elements. */
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
}

interface FieldIds {
  hintId: string | undefined;
  errorId: string | undefined;
  describedBy: string | undefined;
}

function fieldIds({ id, hint, error }: FieldFrameProps): FieldIds {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedBy = [hintId, errorId].filter((value) => value !== undefined).join(' ');
  return { hintId, errorId, describedBy: describedBy === '' ? undefined : describedBy };
}

function FieldFrame({
  frame,
  ids,
  children,
}: {
  frame: FieldFrameProps;
  ids: FieldIds;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={frame.id} className="block text-sm font-medium text-slate-800">
        {frame.label}
      </label>
      {children}
      {frame.hint !== undefined && (
        <p id={ids.hintId} className="text-sm text-slate-600">
          {frame.hint}
        </p>
      )}
      {frame.error !== undefined && (
        <p id={ids.errorId} className="text-sm text-red-700">
          {frame.error}
        </p>
      )}
    </div>
  );
}

type InputFieldProps = FieldFrameProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>;

export function InputField({ id, label, hint, error, ...input }: InputFieldProps) {
  const frame = { id, label, hint, error };
  const ids = fieldIds(frame);
  return (
    <FieldFrame frame={frame} ids={ids}>
      <input
        {...input}
        id={id}
        aria-describedby={ids.describedBy}
        aria-invalid={error === undefined ? undefined : true}
        className={CONTROL}
      />
    </FieldFrame>
  );
}

type SelectFieldProps = FieldFrameProps &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'children'> & { options: readonly string[] };

export function SelectField({ id, label, hint, error, options, ...select }: SelectFieldProps) {
  const frame = { id, label, hint, error };
  const ids = fieldIds(frame);
  return (
    <FieldFrame frame={frame} ids={ids}>
      <select
        {...select}
        id={id}
        aria-describedby={ids.describedBy}
        aria-invalid={error === undefined ? undefined : true}
        className={CONTROL}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </FieldFrame>
  );
}

import type { InputHTMLAttributes } from 'react';

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  value: number;
  min?: number;
  max: number;
  step?: number;
  label: string;
  valueText?: string;
  onChange(value: number): void;
  /** Fired when the user lets go (seek on release rather than on every pixel). */
  onCommit?(value: number): void;
}

export function Range({
  value,
  min = 0,
  max,
  step = 1,
  label,
  valueText,
  onChange,
  onCommit,
  className = '',
  ...rest
}: Props) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      className={`tp-range w-full ${className}`}
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      {...(valueText ? { 'aria-valuetext': valueText } : {})}
      style={{ ['--pct' as string]: `${Math.min(100, Math.max(0, pct))}%` }}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
      onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
      {...rest}
    />
  );
}

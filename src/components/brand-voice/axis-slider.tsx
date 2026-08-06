"use client";

import type { BrandVoiceAxis } from "@/domain";

export interface AxisSliderProps {
  axis: BrandVoiceAxis;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  /**
   * The drag is over and this value is the user's decision.
   *
   * Separate from `onChange` because a range input fires continuously while
   * dragging: the summary should follow every frame, but a save should not.
   */
  onCommit?: () => void;
}

/**
 * One voice axis.
 *
 * A real `input[type=range]`, so keyboard operation, focus, and screen-reader
 * announcement come from the platform rather than from a reimplementation of
 * them. The pole labels are the accessible name; the numeric value is exposed
 * through `aria-valuetext` so it is read as "warm to formal", not "62".
 */
export function AxisSlider({
  axis,
  value,
  disabled = false,
  onChange,
  onCommit,
}: AxisSliderProps) {
  const label = `${axis.leftLabel} to ${axis.rightLabel}`;

  return (
    <li className="grid grid-cols-[7rem_1fr_7rem] items-center gap-3">
      <label
        htmlFor={`axis-${axis.key}`}
        className="text-[13px] font-medium text-gray-950"
      >
        {axis.leftLabel}
      </label>
      <input
        id={`axis-${axis.key}`}
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={`${value} of 100, ${label}`}
        onChange={(event) => onChange(Number(event.target.value))}
        // Three, because each covers a gap the others leave. `pointerup` ends a
        // drag; `keyup` ends an arrow-key adjustment; `blur` catches a keyboard
        // user who tabs away, which fires no `keyup` on this control.
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-200 accent-purple-600 disabled:cursor-not-allowed disabled:opacity-60"
      />
      <span className="text-right text-[13px] text-gray-500">{axis.rightLabel}</span>
    </li>
  );
}

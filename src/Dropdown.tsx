import { Select } from "@base-ui/react/select";

import "./Dropdown.css";

interface DropdownProps<Value extends string> {
  label: string;
  value: Value | null;
  options: ReadonlyArray<{ value: Value; label: string }>;
  onChange(value: Value): void;
  disabled?: boolean;
  placeholder?: string;
}

export default function Dropdown<Value extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  placeholder,
}: DropdownProps<Value>) {
  return (
    <div className="dropdown-field">
      <Select.Root<Value>
        value={value}
        items={options}
        disabled={disabled || options.length === 0}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <Select.Label className="dropdown-label">{label}</Select.Label>
        <Select.Trigger className="dropdown-trigger">
          <Select.Value className="dropdown-value" placeholder={placeholder} />
          <span className="dropdown-icon" aria-hidden="true" />
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner
            className="dropdown-positioner"
            align="start"
            sideOffset={5}
            alignItemWithTrigger={false}
          >
            <Select.Popup className="dropdown-popup">
              <Select.List className="dropdown-list">
                {options.map((option) => (
                  <Select.Item
                    key={option.value}
                    value={option.value}
                    className="dropdown-option"
                  >
                    <Select.ItemText>{option.label}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.List>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}

import { Field } from "@base-ui/react/field";
import { Input } from "@base-ui/react/input";
import * as stylex from "@stylexjs/stylex";
import { s } from "../styles";

export function TextField({
  label,
  error,
  ...props
}: Input.Props & { label: string; error?: string }) {
  return (
    <Field.Root invalid={Boolean(error)}>
      <Field.Label {...stylex.props(s.fieldLabel)}>{label}</Field.Label>
      <Input {...stylex.props(s.input)} {...props} />
      {Boolean(error) && (
        <Field.Error match role="alert" {...stylex.props(s.fieldError)}>
          {error}
        </Field.Error>
      )}
    </Field.Root>
  );
}

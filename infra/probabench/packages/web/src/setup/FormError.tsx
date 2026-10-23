/** An alert for a problem the user can act on; renders nothing without one. */
export function FormError({ message }: { message: string | null | undefined }) {
  return message ? (
    <p role="alert" className="form-error">
      {message}
    </p>
  ) : null;
}

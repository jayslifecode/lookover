/*
 * What the run's event stream reported, other than a reconnect (the live indicator says that): a message
 * that was not an event, or a stream the server closed for good. A solid notice under the top bar, so
 * the reader knows the page may be missing part of the run, and what to do (the message says).
 */

export function StreamNotice({ message }: { readonly message: string }) {
  return (
    <p role="status" className="m-0 mb-4 rounded-lg border border-line-strong bg-bg-1 px-4 py-3 text-ink">
      {message}
    </p>
  );
}

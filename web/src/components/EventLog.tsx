import { formatTime, formatUsdc } from "@/lib/format";
import type { AmanatEvent } from "@/lib/types";

export function EventLog({ events }: { events: AmanatEvent[] }) {
  if (events.length === 0) {
    return (
      <div role="status" className="bp-plate bp-app-empty">
        <div className="bp-app-empty-icon bp-app-mono" aria-hidden="true">0</div>
        <h3 className="bp-app-notice-title">No events recorded yet</h3>
        <p className="bp-app-notice-body mx-auto max-w-md">
          Nothing has been logged for this mandate. Events appear here once payments are requested.
        </p>
      </div>
    );
  }

  return (
    <div className="bp-plate bp-app-table-wrap">
      <table className="bp-app-table">
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th scope="col">Recipient</th>
            <th scope="col" className="bp-app-num">Amount</th>
            <th scope="col">Code / Status</th>
            <th scope="col" className="bp-app-num">Time</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event, idx) => (
            <tr key={`${event.mandateId}-${event.atMs}-${idx}`}>
              <td className="whitespace-nowrap">
                <span className="bp-app-chip">{event.name}</span>
              </td>
              <td className="bp-app-mono max-w-[200px] truncate text-xs text-bp-ink">
                {event.recipient ?? "—"}
              </td>
              <td className="bp-app-mono bp-app-num whitespace-nowrap text-xs text-bp-ink">
                {event.amount ? formatUsdc(event.amount) : "—"}
              </td>
              <td className="whitespace-nowrap">
                {event.code ? (
                  <span className="bp-app-chip bp-app-chip-reject">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                      <path d="M2 2l6 6M8 2 2 8" />
                    </svg>
                    {event.code}
                  </span>
                ) : (
                  <span className="text-xs text-bp-muted">—</span>
                )}
              </td>
              <td className="bp-app-mono bp-app-num whitespace-nowrap text-xs text-bp-muted">
                {formatTime(event.atMs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

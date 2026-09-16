import { Page } from "../components/Page";
import { useAuth } from "./AuthProvider";
import { LoginForm } from "./LoginForm";

/**
 * Shown instead of any app route whenever authStatus is "login-required" or
 * "server-unreachable" -- no app routes render underneath it either way (see
 * docs/data-sync.md). Three distinct shapes (finding #1):
 *
 * - Offline with no marker ("login-required" while `online` is false): a
 *   "Network required" notice and no form -- there is nothing to sign in
 *   against yet. No manual retry either: AuthProvider re-checks on its own as
 *   soon as the "online" event fires, which is what clears this screen.
 * - Online with no marker, decisively anonymous ("login-required" while
 *   `online` is true): the ordinary sign-in form.
 * - Online with no marker, but the startup check could not get a decisive
 *   answer -- network failure, timeout, 5xx, non-JSON body
 *   ("server-unreachable"): the sign-in form stays reachable next to an
 *   explanation and a manual Retry action, instead of dead-ending an
 *   otherwise-online user who simply hit a flaky server.
 */
export function LoginPage() {
  const { online, retry, status } = useAuth();

  if (status === "login-required" && !online) {
    return (
      <Page heading="Sign in" documentTitle="Sign in · Gym HUD">
        <div className="card">
          <p className="card__title">Network required</p>
          <p className="muted">
            This device has not signed in to Gym HUD before, so a connection is needed once. Connect
            to the internet to sign in; after that you can keep using Gym HUD offline. This screen
            updates on its own once you are back online.
          </p>
        </div>
      </Page>
    );
  }

  return (
    <Page heading="Sign in" documentTitle="Sign in · Gym HUD">
      {status === "server-unreachable" && (
        <div className="card">
          <p className="card__title">Server unreachable</p>
          <p className="muted">
            Gym HUD could not reach the server to check for a previous sign-in on this device. You can
            still sign in below, or try again.
          </p>
          <button className="button button--quiet" type="button" onClick={() => void retry()}>
            Retry
          </button>
        </div>
      )}
      <LoginForm />
    </Page>
  );
}

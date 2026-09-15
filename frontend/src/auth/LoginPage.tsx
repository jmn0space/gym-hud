import { Page } from "../components/Page";
import { useAuth } from "./AuthProvider";
import { LoginForm } from "./LoginForm";

/**
 * Shown instead of any app route whenever authStatus is "login-required":
 * either this device has never signed in before, or the user just signed out.
 * No app routes render underneath it.
 */
export function LoginPage() {
  const { firstLoginNeedsNetwork } = useAuth();

  return (
    <Page heading="Sign in" documentTitle="Sign in · Gym HUD">
      {firstLoginNeedsNetwork ? (
        <div className="card">
          <p className="card__title">Network required</p>
          <p className="muted">
            This device has not signed in to Gym HUD before, so a connection is needed once. Connect
            to the internet to sign in; after that you can keep using Gym HUD offline.
          </p>
        </div>
      ) : (
        <LoginForm />
      )}
    </Page>
  );
}

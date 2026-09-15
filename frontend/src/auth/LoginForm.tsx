import { useId, useState, type SubmitEvent } from "react";

import { useAuth } from "./AuthProvider";

/** Shared username/password form, used by both the full-screen LoginPage and the expired-session banner's inline sign-in. */
export function LoginForm() {
  const { dismissLoginError, login, loginError, loginPending } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const usernameId = useId();
  const passwordId = useId();

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loginPending) {
      return;
    }
    const succeeded = await login(username, password);
    if (succeeded) {
      // Credentials never persist anywhere; clearing them here is defense in
      // depth even though nothing keeps this component mounted after sign-in.
      setUsername("");
      setPassword("");
    }
  }

  function clearErrorOnEdit() {
    if (loginError !== null) {
      dismissLoginError();
    }
  }

  return (
    <form className="stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
      {loginError !== null && (
        <div className="storage-error" role="alert">
          <p>{loginError.message}</p>
        </div>
      )}
      <div className="field">
        <label htmlFor={usernameId}>Username</label>
        <input
          id={usernameId}
          name="username"
          type="text"
          autoComplete="username"
          className="text-input"
          value={username}
          onChange={(event) => {
            setUsername(event.target.value);
            clearErrorOnEdit();
          }}
          required
        />
      </div>
      <div className="field">
        <label htmlFor={passwordId}>Password</label>
        <input
          id={passwordId}
          name="password"
          type="password"
          autoComplete="current-password"
          className="text-input"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            clearErrorOnEdit();
          }}
          required
        />
      </div>
      <button className="button button--primary" type="submit" aria-disabled={loginPending}>
        {loginPending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

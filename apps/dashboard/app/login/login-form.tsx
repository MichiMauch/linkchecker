"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions.js";

const initial: LoginState = {};

export function LoginForm() {
  const [state, action, pending] = useActionState(login, initial);
  return (
    <form action={action} className="login-form">
      <input
        type="password"
        name="password"
        placeholder="Passwort"
        autoFocus
        required
        autoComplete="current-password"
      />
      <button type="submit" disabled={pending}>
        {pending ? "…" : "Anmelden"}
      </button>
      {state.error ? <div className="login-error">{state.error}</div> : null}
    </form>
  );
}

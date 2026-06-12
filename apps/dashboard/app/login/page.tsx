import { LoginForm } from "./login-form.js";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <div className="login-wrap">
      <h2>Anmelden</h2>
      <p className="muted">Dieses Dashboard ist passwortgeschützt.</p>
      <LoginForm />
    </div>
  );
}

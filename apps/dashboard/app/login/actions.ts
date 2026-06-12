"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, safeEqual, sessionToken } from "../lib/auth.js";

export interface LoginState {
  error?: string;
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const password = String(formData.get("password") ?? "");
  const expected = process.env.DASHBOARD_PASSWORD ?? "";

  if (!expected || !safeEqual(password, expected)) {
    return { error: "Falsches Passwort." };
  }

  const token = await sessionToken();
  (await cookies()).set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  redirect("/");
}

export async function logout(): Promise<void> {
  (await cookies()).delete(COOKIE_NAME);
  redirect("/login");
}

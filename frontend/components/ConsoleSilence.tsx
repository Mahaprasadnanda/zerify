"use client";

import { useEffect } from "react";

/**
 * Production hardening: silence console methods that are commonly used for debug output.
 * Does not change application behavior outside the console.
 */
export function ConsoleSilence() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    const noop = () => {};
    console.log = noop;
    console.error = noop;
    console.debug = noop;
  }, []);
  return null;
}

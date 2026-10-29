"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

function subscribeVisibility(callback: () => void): () => void {
  document.addEventListener("visibilitychange", callback);
  return () => document.removeEventListener("visibilitychange", callback);
}

function getVisibilitySnapshot(): boolean {
  return document.visibilityState !== "hidden";
}

function getServerVisibilitySnapshot(): boolean {
  return true;
}

/**
 * Gates timers/animations so they pause automatically when scrolled out of view
 * (IntersectionObserver) or when the browser tab is hidden.
 */
export function useAnimationActive<T extends HTMLElement>() {
  const containerRef = useRef<T | null>(null);
  const [isInView, setIsInView] = useState(true);
  const isTabVisible = useSyncExternalStore(
    subscribeVisibility,
    getVisibilitySnapshot,
    getServerVisibilitySnapshot,
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) {
          setIsInView(entry.isIntersecting);
        }
      },
      { threshold: 0.08 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return {
    containerRef,
    isViewportActive: isInView && isTabVisible,
  };
}

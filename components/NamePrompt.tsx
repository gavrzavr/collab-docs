"use client";

import { useState } from "react";

const COLORS = [
  "#FF6B6B", "#4ECDC4", "#45B7D1", "#FFA07A",
  "#98D8C8", "#F7DC6F", "#BB8FCE", "#85C1E9",
  "#F0B27A", "#82E0AA", "#F1948A", "#AED6F1",
];

function randomColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

interface NamePromptProps {
  onSubmit: (name: string, color: string) => void;
}

export default function NamePrompt({ onSubmit }: NamePromptProps) {
  const [name, setName] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const color = randomColor();
    localStorage.setItem("collab-docs-name", trimmed);
    localStorage.setItem("collab-docs-color", color);
    onSubmit(trimmed, color);
  }

  return (
    <div className="name-prompt-overlay">
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-xl shadow-2xl p-8 max-w-sm w-full mx-4"
      >
        <h2 className="text-xl font-semibold mb-2">Welcome to PostPaper</h2>
        <p className="text-gray-500 text-sm mb-6">
          Enter your display name to start collaborating
        </p>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          autoFocus
          className="w-full px-4 py-2 border border-gray-300 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-black focus:border-transparent"
          maxLength={30}
        />
        <button
          type="submit"
          disabled={!name.trim()}
          className="w-full px-4 py-2 bg-black text-white rounded-lg font-medium hover:bg-gray-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Join Document
        </button>
      </form>
    </div>
  );
}

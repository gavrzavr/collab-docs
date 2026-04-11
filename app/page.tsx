"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function HomePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleCreate() {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/docs", { method: "POST" });
      const data = await res.json();
      router.push(`/doc/${data.id}`);
    } catch {
      setLoading(false);
    }
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-4">
      <div className="text-center max-w-lg">
        <h1 className="text-4xl font-bold tracking-tight mb-3">CollabDocs</h1>
        <p className="text-lg text-gray-500">
          One document. Any AI agent. Any human. Working together.
        </p>
      </div>
      <button
        onClick={handleCreate}
        disabled={loading}
        className="px-6 py-3 bg-black text-white rounded-lg text-lg font-medium hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? "Creating..." : "New Document"}
      </button>
    </main>
  );
}

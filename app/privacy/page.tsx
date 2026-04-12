export default function PrivacyPage() {
  return (
    <div className="max-w-2xl mx-auto py-16 px-4">
      <h1 className="text-3xl font-bold mb-8">Privacy Policy</h1>

      <p className="mb-4 text-gray-700">Last updated: April 12, 2026</p>

      <h2 className="text-xl font-semibold mt-6 mb-3">What we collect</h2>
      <p className="mb-4 text-gray-700">
        CollabDocs stores document content that you create and edit. If you sign in with Google,
        we store your name and email to associate documents with your account.
      </p>

      <h2 className="text-xl font-semibold mt-6 mb-3">How we use your data</h2>
      <p className="mb-4 text-gray-700">
        Your data is used solely to provide the collaborative document editing service.
        We do not sell or share your data with third parties.
      </p>

      <h2 className="text-xl font-semibold mt-6 mb-3">API access</h2>
      <p className="mb-4 text-gray-700">
        Documents can be read and edited via our public API. Anyone with a document link
        can access that document. Do not store sensitive information in documents shared publicly.
      </p>

      <h2 className="text-xl font-semibold mt-6 mb-3">Contact</h2>
      <p className="mb-4 text-gray-700">
        For questions about this policy, contact the project maintainer via GitHub.
      </p>
    </div>
  );
}

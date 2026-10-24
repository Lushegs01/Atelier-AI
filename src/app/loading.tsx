export default function Loading() {
  return (
    <main
      id="main-content"
      className="max-w-6xl mx-auto p-10"
      aria-busy="true"
      aria-label="Loading page"
    >
      <div className="skeleton h-10 w-64 mb-6" />
      <div className="skeleton h-96" />
    </main>
  );
}

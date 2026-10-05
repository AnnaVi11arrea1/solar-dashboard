export default async function Login({ searchParams }: PageProps<"/login">) {
  const { next, error } = await searchParams;
  return (
    <main className="page login">
      <form className="card" method="post" action="/api/login">
        <h1>SOLAR<span className="h1-accent">{"//GRID"}</span></h1>
        <label>
          <span className="label">Password</span>
          <input type="password" name="password" autoFocus required autoComplete="current-password" />
        </label>
        <input type="hidden" name="next" value={typeof next === "string" ? next : "/"} />
        {error && <p className="error">That password didn’t match.</p>}
        <button className="button" type="submit">Open dashboard</button>
      </form>
    </main>
  );
}

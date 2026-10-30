/** D1 operations used by the history service. */
export interface Statement {
  bind(...values: (string | number)[]): Statement;
  run(): Promise<unknown>;
  all<T>(): Promise<{ results: T[] }>;
}

export interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown>;
}

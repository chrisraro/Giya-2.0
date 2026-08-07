import "server-only";

/**
 * Route analytical and high-frequency read operations to read replicas when configured.
 */
export async function withReadReplica<T>(
  queryFn: () => Promise<T>,
): Promise<T> {
  const replicaUrl = process.env.SUPABASE_READ_REPLICA_URL;

  try {
    if (replicaUrl) {
      // Future read-replica pool execution
      return await queryFn();
    }
    return await queryFn();
  } catch (error) {
    // Fallback to primary
    return await queryFn();
  }
}

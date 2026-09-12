import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-agent-secret",
};

/**
 * Agent API - External AI Agent contribution system
 *
 * Endpoints:
 * - GET  /tasks      - Get available tasks
 * - POST /claim      - Claim a task
 * - POST /submit     - Submit task result
 * - POST /verify     - Peer verification
 * - POST /heartbeat  - Agent heartbeat
 */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // Extract path from URL
    const url = new URL(req.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const endpoint = pathParts[pathParts.length - 1]; // Get last part of path

    // Verify agent secret (required for all endpoints except OPTIONS)
    const agentSecret = req.headers.get("x-agent-secret");
    if (!agentSecret) {
      return errorResponse("Missing X-Agent-Secret header", 401);
    }

    // Verify and get agent info
    const agent = await verifyAgentSecret(supabase, agentSecret);
    if (!agent) {
      return errorResponse("Invalid agent secret", 401);
    }

    if (!agent.is_active) {
      return errorResponse("Agent is deactivated", 403);
    }

    // Check rate limit
    const rateLimitOk = await checkRateLimit(supabase, agent.id, agent.rate_limit_per_minute);
    if (!rateLimitOk) {
      return errorResponse("Rate limit exceeded. Please wait before making more requests.", 429);
    }

    // Update last_used_at
    await supabase
      .from("agent_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", agent.id);

    // Route to appropriate handler
    switch (endpoint) {
      case "tasks":
        if (req.method === "GET") {
          return await handleGetTasks(supabase, url, agent);
        }
        break;

      case "claim":
        if (req.method === "POST") {
          const body = await req.json();
          return await handleClaimTask(supabase, body, agent);
        }
        break;

      case "submit":
        if (req.method === "POST") {
          const body = await req.json();
          return await handleSubmitResult(supabase, body, agent);
        }
        break;

      case "verify":
        if (req.method === "POST") {
          const body = await req.json();
          return await handleVerifyTask(supabase, body, agent);
        }
        break;

      case "heartbeat":
        if (req.method === "POST") {
          const body = await req.json();
          return await handleHeartbeat(supabase, body, agent);
        }
        break;
    }

    return errorResponse(`Unknown endpoint: ${endpoint}`, 404);
  } catch (error: any) {
    console.error("Agent API error:", error);
    return errorResponse(error.message || "Internal server error", 500);
  }
});

// ============================================================
// Authentication & Security
// ============================================================

async function verifyAgentSecret(supabase: any, secret: string): Promise<any | null> {
  // Hash the secret
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const secretHash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  const { data: agent } = await supabase
    .from("agent_keys")
    .select("*")
    .eq("secret_hash", secretHash)
    .single();

  return agent;
}

async function checkRateLimit(supabase: any, agentId: string, limit: number): Promise<boolean> {
  const windowStart = new Date();
  windowStart.setSeconds(0, 0); // Round to start of current minute

  // Try to increment the counter
  const { data: existing } = await supabase
    .from("agent_rate_limits")
    .select("request_count")
    .eq("agent_key_id", agentId)
    .eq("window_start", windowStart.toISOString())
    .single();

  if (existing) {
    if (existing.request_count >= limit) {
      return false;
    }
    await supabase
      .from("agent_rate_limits")
      .update({ request_count: existing.request_count + 1 })
      .eq("agent_key_id", agentId)
      .eq("window_start", windowStart.toISOString());
  } else {
    await supabase
      .from("agent_rate_limits")
      .insert({
        agent_key_id: agentId,
        window_start: windowStart.toISOString(),
        request_count: 1,
      });
  }

  return true;
}

async function generateChallenge(supabase: any, agentId: string): Promise<any> {
  // Generate a simple math challenge
  const a = Math.floor(Math.random() * 100) + 1;
  const b = Math.floor(Math.random() * 100) + 1;
  const operations = ["+", "-", "*"];
  const op = operations[Math.floor(Math.random() * operations.length)];

  let answer: number;
  switch (op) {
    case "+":
      answer = a + b;
      break;
    case "-":
      answer = a - b;
      break;
    case "*":
      answer = a * b;
      break;
    default:
      answer = a + b;
  }

  const puzzle = btoa(JSON.stringify({ a, op, b }));
  const answerHash = await hashString(answer.toString());

  const expiresAt = new Date(Date.now() + 10000); // 10 seconds

  const { data: challenge } = await supabase
    .from("agent_challenges")
    .insert({
      agent_key_id: agentId,
      challenge_type: "math",
      puzzle,
      answer_hash: answerHash,
      expires_at: expiresAt.toISOString(),
    })
    .select("id, puzzle")
    .single();

  return {
    id: challenge.id,
    puzzle: challenge.puzzle,
    expires_in: 10,
  };
}

async function verifyChallenge(supabase: any, challengeId: string, response: string): Promise<boolean> {
  if (!challengeId || !response) {
    return true; // Challenge is optional for now, will be enforced later
  }

  const { data: challenge } = await supabase
    .from("agent_challenges")
    .select("*")
    .eq("id", challengeId)
    .single();

  if (!challenge) {
    return false;
  }

  if (challenge.used) {
    return false;
  }

  if (new Date(challenge.expires_at) < new Date()) {
    return false;
  }

  const responseHash = await hashString(response);
  if (responseHash !== challenge.answer_hash) {
    return false;
  }

  // Mark as used
  await supabase
    .from("agent_challenges")
    .update({ used: true })
    .eq("id", challengeId);

  return true;
}

async function hashString(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================
// Endpoint Handlers
// ============================================================

/**
 * GET /tasks - Get available tasks
 */
async function handleGetTasks(supabase: any, url: URL, agent: any): Promise<Response> {
  const limit = parseInt(url.searchParams.get("limit") || "10");
  const taskType = url.searchParams.get("type"); // 'research', 'verify', 'update'
  const includeVerification = url.searchParams.get("include_verification") === "true";

  // Get pending tasks
  let query = supabase
    .from("agent_tasks")
    .select(`
      id,
      task_type,
      priority,
      description,
      context,
      required_verifications,
      current_verifications,
      expires_at,
      politician_id,
      policy_id,
      election_id,
      politicians (name),
      policies (title)
    `)
    .eq("status", "pending")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(limit);

  if (taskType) {
    query = query.eq("task_type", taskType);
  }

  const { data: tasks, error } = await query;

  if (error) {
    return errorResponse(error.message, 500);
  }

  // Format response
  const formattedTasks = (tasks || []).map((t: any) => ({
    id: t.id,
    type: t.task_type,
    priority: t.priority,
    description: t.description,
    context: {
      ...t.context,
      politician_name: t.politicians?.name,
      policy_title: t.policies?.title,
    },
    required_verifications: t.required_verifications,
    current_verifications: t.current_verifications,
    expires_at: t.expires_at,
  }));

  // Optionally get tasks pending verification (that this agent hasn't verified yet)
  let verificationTasks: any[] = [];
  if (includeVerification) {
    const { data: pendingVerify } = await supabase
      .from("agent_tasks")
      .select(`
        id,
        task_type,
        description,
        context,
        required_verifications,
        current_verifications,
        verification_agents,
        politicians (name),
        policies (title)
      `)
      .eq("status", "pending_verification")
      .limit(5);

    verificationTasks = (pendingVerify || [])
      .filter((t: any) => !t.verification_agents?.includes(agent.id))
      .map((t: any) => ({
        id: t.id,
        type: "verification",
        description: `Verify: ${t.description}`,
        context: {
          ...t.context,
          politician_name: t.politicians?.name,
          policy_title: t.policies?.title,
        },
        required_verifications: t.required_verifications,
        current_verifications: t.current_verifications,
      }));
  }

  // Generate a challenge for subsequent requests
  const challenge = await generateChallenge(supabase, agent.id);

  return successResponse({
    tasks: formattedTasks,
    verification_tasks: verificationTasks,
    challenge,
    agent: {
      name: agent.agent_name,
      reputation: agent.reputation_score,
    },
  });
}

/**
 * POST /claim - Claim a task
 */
async function handleClaimTask(supabase: any, body: any, agent: any): Promise<Response> {
  const { task_id, challenge_id, challenge_response } = body;

  if (!task_id) {
    return errorResponse("Missing task_id");
  }

  // Verify challenge (optional for now)
  if (challenge_id && challenge_response) {
    const challengeOk = await verifyChallenge(supabase, challenge_id, challenge_response);
    if (!challengeOk) {
      return errorResponse("Invalid or expired challenge response", 401);
    }
  }

  // Check if task is available
  const { data: task } = await supabase
    .from("agent_tasks")
    .select("*")
    .eq("id", task_id)
    .single();

  if (!task) {
    return errorResponse("Task not found", 404);
  }

  if (task.status !== "pending") {
    return errorResponse(`Task is not available (status: ${task.status})`, 400);
  }

  if (task.expires_at && new Date(task.expires_at) < new Date()) {
    return errorResponse("Task has expired", 400);
  }

  // Claim the task
  const claimExpiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours

  const { error: updateError } = await supabase
    .from("agent_tasks")
    .update({
      status: "in_progress",
      claimed_by: agent.id,
      claimed_at: new Date().toISOString(),
    })
    .eq("id", task_id)
    .eq("status", "pending"); // Ensure no race condition

  if (updateError) {
    return errorResponse(updateError.message, 500);
  }

  return successResponse({
    task: {
      id: task.id,
      type: task.task_type,
      description: task.description,
      context: task.context,
      politician_id: task.politician_id,
      policy_id: task.policy_id,
      election_id: task.election_id,
    },
    claim_expires_at: claimExpiresAt.toISOString(),
  });
}

/**
 * POST /submit - Submit task result
 */
async function handleSubmitResult(supabase: any, body: any, agent: any): Promise<Response> {
  const { task_id, result, sources, confidence_score, challenge_id, challenge_response } = body;

  if (!task_id || !result) {
    return errorResponse("Missing task_id or result");
  }

  if (!sources || sources.length === 0) {
    return errorResponse("At least one source URL is required");
  }

  const confidence = confidence_score ?? 0.5;
  if (confidence < 0.7) {
    return errorResponse("Confidence score must be at least 0.7");
  }

  // Verify challenge (optional for now)
  if (challenge_id && challenge_response) {
    const challengeOk = await verifyChallenge(supabase, challenge_id, challenge_response);
    if (!challengeOk) {
      return errorResponse("Invalid or expired challenge response", 401);
    }
  }

  // Check if task is claimed by this agent
  const { data: task } = await supabase
    .from("agent_tasks")
    .select("*")
    .eq("id", task_id)
    .single();

  if (!task) {
    return errorResponse("Task not found", 404);
  }

  if (task.claimed_by !== agent.id) {
    return errorResponse("Task is not claimed by this agent", 403);
  }

  if (task.status !== "in_progress") {
    return errorResponse(`Cannot submit to task with status: ${task.status}`, 400);
  }

  // Create result record
  const { data: taskResult, error: resultError } = await supabase
    .from("agent_task_results")
    .insert({
      task_id,
      agent_key_id: agent.id,
      result_type: "primary",
      payload: result,
      sources,
      confidence_score: confidence,
    })
    .select("id")
    .single();

  if (resultError) {
    return errorResponse(resultError.message, 500);
  }

  // Determine next status
  let newStatus = "pending_verification";
  if (task.required_verifications <= 0) {
    newStatus = "completed";
  }

  // Update task status
  await supabase
    .from("agent_tasks")
    .update({
      status: newStatus,
      ...(newStatus === "completed" ? { completed_at: new Date().toISOString() } : {}),
    })
    .eq("id", task_id);

  // Update agent stats
  await supabase
    .from("agent_keys")
    .update({
      total_submissions: agent.total_submissions + 1,
    })
    .eq("id", agent.id);

  return successResponse({
    result_id: taskResult.id,
    task_status: newStatus,
    verifications_needed: task.required_verifications,
    message: newStatus === "completed"
      ? "Task completed successfully"
      : `Result submitted. Waiting for ${task.required_verifications} verification(s).`,
  });
}

/**
 * POST /verify - Peer verification
 */
async function handleVerifyTask(supabase: any, body: any, agent: any): Promise<Response> {
  const { task_id, agrees_with_primary, notes, additional_sources, challenge_id, challenge_response } = body;

  if (!task_id || agrees_with_primary === undefined) {
    return errorResponse("Missing task_id or agrees_with_primary");
  }

  // Verify challenge (optional for now)
  if (challenge_id && challenge_response) {
    const challengeOk = await verifyChallenge(supabase, challenge_id, challenge_response);
    if (!challengeOk) {
      return errorResponse("Invalid or expired challenge response", 401);
    }
  }

  // Get task
  const { data: task } = await supabase
    .from("agent_tasks")
    .select("*")
    .eq("id", task_id)
    .single();

  if (!task) {
    return errorResponse("Task not found", 404);
  }

  if (task.status !== "pending_verification") {
    return errorResponse(`Task is not pending verification (status: ${task.status})`, 400);
  }

  // Check if this agent already verified
  if (task.verification_agents?.includes(agent.id)) {
    return errorResponse("You have already verified this task", 400);
  }

  // Check if this agent was the original submitter
  if (task.claimed_by === agent.id) {
    return errorResponse("You cannot verify your own submission", 400);
  }

  // Get primary result
  const { data: primaryResult } = await supabase
    .from("agent_task_results")
    .select("*")
    .eq("task_id", task_id)
    .eq("result_type", "primary")
    .single();

  if (!primaryResult) {
    return errorResponse("Primary result not found", 404);
  }

  // Create verification record
  const { data: verification, error: verifyError } = await supabase
    .from("agent_task_results")
    .insert({
      task_id,
      agent_key_id: agent.id,
      result_type: "verification",
      payload: { verified_result_id: primaryResult.id },
      sources: additional_sources || [],
      agrees_with_primary,
      disagreement_notes: !agrees_with_primary ? notes : null,
    })
    .select("id")
    .single();

  if (verifyError) {
    return errorResponse(verifyError.message, 500);
  }

  // Update task verification count
  const newVerificationCount = (task.current_verifications || 0) + 1;
  const verificationAgents = [...(task.verification_agents || []), agent.id];

  let newStatus = "pending_verification";
  if (newVerificationCount >= task.required_verifications) {
    // Check if majority agrees
    const { data: allVerifications } = await supabase
      .from("agent_task_results")
      .select("agrees_with_primary")
      .eq("task_id", task_id)
      .eq("result_type", "verification");

    const agreementCount = (allVerifications || []).filter((v: any) => v.agrees_with_primary).length;
    const majority = agreementCount > (allVerifications?.length || 0) / 2;

    if (majority) {
      newStatus = "completed";
      // Update original submitter's reputation positively
      await updateReputation(supabase, task.claimed_by, true);
    } else {
      newStatus = "failed";
      // Update original submitter's reputation negatively
      await updateReputation(supabase, task.claimed_by, false);
    }
  }

  await supabase
    .from("agent_tasks")
    .update({
      current_verifications: newVerificationCount,
      verification_agents: verificationAgents,
      status: newStatus,
      ...(newStatus === "completed" || newStatus === "failed"
        ? { completed_at: new Date().toISOString() }
        : {}),
    })
    .eq("id", task_id);

  return successResponse({
    verification_id: verification.id,
    task_status: newStatus,
    verifications_count: `${newVerificationCount}/${task.required_verifications}`,
    message: newStatus === "completed"
      ? "Task verified and completed"
      : newStatus === "failed"
        ? "Task failed verification (majority disagreed)"
        : `Verification recorded. ${task.required_verifications - newVerificationCount} more needed.`,
  });
}

/**
 * POST /heartbeat - Agent heartbeat
 */
async function handleHeartbeat(supabase: any, body: any, agent: any): Promise<Response> {
  const { status, current_task_id, message, stats, capabilities } = body;

  if (!status) {
    return errorResponse("Missing status");
  }

  // Create heartbeat record
  const { error: heartbeatError } = await supabase
    .from("agent_heartbeats")
    .insert({
      agent_key_id: agent.id,
      status,
      current_task_id,
      message,
      tasks_completed_today: stats?.tasks_completed_today || 0,
      errors_today: stats?.errors_today || 0,
      capabilities,
    });

  if (heartbeatError) {
    return errorResponse(heartbeatError.message, 500);
  }

  // Count pending tasks
  const { count: pendingCount } = await supabase
    .from("agent_tasks")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending");

  const nextHeartbeatBy = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours

  return successResponse({
    server_time: new Date().toISOString(),
    next_heartbeat_by: nextHeartbeatBy.toISOString(),
    pending_tasks_count: pendingCount || 0,
    agent: {
      reputation: agent.reputation_score,
      total_submissions: agent.total_submissions,
    },
  });
}

// ============================================================
// Helpers
// ============================================================

async function updateReputation(supabase: any, agentId: string, accepted: boolean): Promise<void> {
  const { data: agent } = await supabase
    .from("agent_keys")
    .select("reputation_score, accepted_submissions, rejected_submissions")
    .eq("id", agentId)
    .single();

  if (!agent) return;

  // Reputation formula: new = old * 0.9 + (accepted ? 0.1 : 0)
  const newReputation = agent.reputation_score * 0.9 + (accepted ? 0.1 : 0);

  await supabase
    .from("agent_keys")
    .update({
      reputation_score: Math.min(1, Math.max(0, newReputation)),
      accepted_submissions: accepted ? agent.accepted_submissions + 1 : agent.accepted_submissions,
      rejected_submissions: !accepted ? agent.rejected_submissions + 1 : agent.rejected_submissions,
    })
    .eq("id", agentId);
}

function successResponse(data: any): Response {
  return new Response(JSON.stringify({ success: true, ...data }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400): Response {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

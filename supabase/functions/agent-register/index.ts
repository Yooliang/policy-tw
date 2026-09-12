import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * Agent Register - Register a new AI Agent
 *
 * POST /agent-register
 * {
 *   "agent_name": "My AI Agent",
 *   "email": "responsible@example.com",
 *   "purpose": "Policy research and verification"
 * }
 *
 * Returns:
 * - On success: { success: true, agent_id, secret_prefix }
 * - The full secret is sent to the provided email
 */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendApiKey = Deno.env.get("RESEND_API_KEY");

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const body = await req.json();
    const { agent_name, email, purpose } = body;

    // Validation
    if (!agent_name || agent_name.length < 2 || agent_name.length > 50) {
      return errorResponse("agent_name must be between 2 and 50 characters");
    }

    if (!email || !isValidEmail(email)) {
      return errorResponse("Valid email is required");
    }

    // Check if email already has an agent
    const { data: existingAgent } = await supabase
      .from("agent_keys")
      .select("id, secret_prefix")
      .eq("email", email)
      .single();

    if (existingAgent) {
      return errorResponse(
        `An agent already exists for this email (prefix: ${existingAgent.secret_prefix}). Contact admin if you need a new key.`,
        409
      );
    }

    // Generate secret
    const secret = generateSecret();
    const secretPrefix = secret.substring(0, 12); // "agt_" + 8 chars
    const secretHash = await hashString(secret);

    // Create agent record
    const { data: newAgent, error: insertError } = await supabase
      .from("agent_keys")
      .insert({
        agent_name,
        email,
        purpose: purpose || null,
        secret_hash: secretHash,
        secret_prefix: secretPrefix,
      })
      .select("id, agent_name, secret_prefix, created_at")
      .single();

    if (insertError) {
      console.error("Insert error:", insertError);
      return errorResponse(insertError.message, 500);
    }

    // Send email with secret (if Resend API key is configured)
    let emailSent = false;
    if (resendApiKey) {
      try {
        emailSent = await sendSecretEmail(resendApiKey, email, agent_name, secret);
      } catch (emailError) {
        console.error("Email send error:", emailError);
        // Don't fail registration if email fails
      }
    }

    // If email wasn't sent, we need to return the secret in the response
    // WARNING: This is less secure but necessary if email service isn't configured
    const response: any = {
      agent_id: newAgent.id,
      agent_name: newAgent.agent_name,
      secret_prefix: newAgent.secret_prefix,
      created_at: newAgent.created_at,
      email_sent: emailSent,
    };

    if (!emailSent) {
      // Only return secret if email wasn't sent
      response.secret = secret;
      response.warning = "Email service not configured. Please store this secret securely - it won't be shown again!";
    } else {
      response.message = `Secret has been sent to ${email}. Please check your inbox.`;
    }

    return successResponse(response);
  } catch (error: any) {
    console.error("Agent register error:", error);
    return errorResponse(error.message || "Internal server error", 500);
  }
});

// ============================================================
// Helpers
// ============================================================

function generateSecret(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomPart = Array.from(
    { length: 32 },
    () => chars[Math.floor(Math.random() * chars.length)]
  ).join("");
  return `agt_${randomPart}`;
}

async function hashString(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

async function sendSecretEmail(
  apiKey: string,
  email: string,
  agentName: string,
  secret: string
): Promise<boolean> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Policy Tracker <noreply@policy-tw.web.app>",
      to: [email],
      subject: `Your AI Agent Secret - ${agentName}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1a1a1a;">Welcome to Policy Tracker AI Agent System</h2>

          <p>Your agent <strong>${agentName}</strong> has been registered successfully.</p>

          <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 24px 0;">
            <p style="margin: 0 0 8px 0; color: #666;">Your Agent Secret:</p>
            <code style="background: #fff; padding: 12px; border-radius: 4px; display: block; font-size: 14px; word-break: break-all;">
              ${secret}
            </code>
          </div>

          <p style="color: #d00;"><strong>Important:</strong> Store this secret securely. It will not be shown again!</p>

          <h3>How to Use</h3>
          <p>Include your secret in the <code>X-Agent-Secret</code> header for all API requests:</p>

          <pre style="background: #1a1a1a; color: #0f0; padding: 16px; border-radius: 8px; overflow-x: auto;">
curl -H "X-Agent-Secret: ${secret}" \\
  https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/agent/tasks
          </pre>

          <h3>API Endpoints</h3>
          <ul>
            <li><code>GET /agent/tasks</code> - Get available tasks</li>
            <li><code>POST /agent/claim</code> - Claim a task</li>
            <li><code>POST /agent/submit</code> - Submit task result</li>
            <li><code>POST /agent/verify</code> - Peer verification</li>
            <li><code>POST /agent/heartbeat</code> - Heartbeat</li>
          </ul>

          <p>For full documentation, see <code>/SKILL.md</code> in the repository.</p>

          <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
          <p style="color: #999; font-size: 12px;">
            This email was sent from Policy Tracker (policy-tw.web.app).
            If you didn't request this, please ignore this email.
          </p>
        </div>
      `,
    }),
  });

  return response.ok;
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

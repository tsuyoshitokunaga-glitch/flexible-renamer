import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
})

const cryptoProvider = Stripe.createSubtleCryptoProvider()

serve(async (req) => {
  const signature = req.headers.get("Stripe-Signature")

  if (!signature) {
    return new Response("No signature", { status: 400 })
  }

  try {
    const body = await req.text()
    const endpointSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")
    
    // Verify the event
    const event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      endpointSecret!,
      undefined,
      cryptoProvider
    )

    // Setup Supabase Client (Use Service Role Key to bypass RLS)
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    )

    // Handle the event
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session
      const userId = session.metadata?.user_id
      const customerId = session.customer as string

      console.log(`Processing checkout for user: ${userId}`)

      if (userId) {
        // Update user_usage table
        const { error } = await supabaseClient
          .from("user_usage")
          .update({
            is_premium: true,
            stripe_customer_id: customerId,
            subscription_status: 'active',
            // Set billing date to 1 month from now (approx)
            next_billing_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          })
          .eq("id", userId)

        if (error) {
          console.error("Error updating user profile:", error)
          return new Response("Database update failed", { status: 500 })
        }
        console.log("User profile updated successfully")
      }
    } else if (event.type === "customer.subscription.deleted") {
      // Handle cancellation
      const subscription = event.data.object as Stripe.Subscription
      const customerId = subscription.customer as string

      // Find user by stripe_customer_id
      const { data: users } = await supabaseClient
        .from("user_usage")
        .select("id")
        .eq("stripe_customer_id", customerId)
        .limit(1)

      if (users && users.length > 0) {
        await supabaseClient
          .from("user_usage")
          .update({
            subscription_status: 'canceled',
            // Note: We might want to keep is_premium true until period end, 
            // but for simplicity let's rely on status.
          })
          .eq("id", users[0].id)
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { "Content-Type": "application/json" },
    })

  } catch (err) {
    console.error(`Webhook Error: ${err.message}`)
    return new Response(`Webhook Error: ${err.message}`, { status: 400 })
  }
})
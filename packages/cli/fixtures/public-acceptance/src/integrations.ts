import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

export const integrations = { createClient, Stripe };

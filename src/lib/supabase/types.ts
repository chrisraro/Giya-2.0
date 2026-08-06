// GENERATED FILE: Supabase types for the LIVE project zlfxfzlnklqhajacngxf.
// NOT dcnpuvtbftpbcjcvfnlt, which is retired but still exists and still
// answers its keys. See supabase/README.md "Project history".
// Regenerate after migrations (MCP generate_typescript_types). Do not edit by hand.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ai_usage_events: {
        Row: {
          business_id: string | null
          cost_micros: number
          created_at: string
          id: string
          kind: string
          model: string | null
          ref_id: string | null
          units: number
          user_id: string | null
        }
        Insert: {
          business_id?: string | null
          cost_micros?: number
          created_at?: string
          id?: string
          kind: string
          model?: string | null
          ref_id?: string | null
          units: number
          user_id?: string | null
        }
        Update: {
          business_id?: string | null
          cost_micros?: number
          created_at?: string
          id?: string
          kind?: string
          model?: string | null
          ref_id?: string | null
          units?: number
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_events_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_usage_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          actor_kind: string
          actor_role: string | null
          after: Json | null
          before: Json | null
          business_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          ip: unknown
          reason: string | null
          request_id: string | null
          user_agent: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_kind: string
          actor_role?: string | null
          after?: Json | null
          before?: Json | null
          business_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
          ip?: unknown
          reason?: string | null
          request_id?: string | null
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_kind?: string
          actor_role?: string | null
          after?: Json | null
          before?: Json | null
          business_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          ip?: unknown
          reason?: string | null
          request_id?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      balance_check_findings: {
        Row: {
          business_id: string
          cached_balance: number
          checked_at: string
          consumer_id: string
          drifted: boolean
          ledger_sum: number
        }
        Insert: {
          business_id: string
          cached_balance: number
          checked_at?: string
          consumer_id: string
          drifted?: boolean
          ledger_sum: number
        }
        Update: {
          business_id?: string
          cached_balance?: number
          checked_at?: string
          consumer_id?: string
          drifted?: boolean
          ledger_sum?: number
        }
        Relationships: [
          {
            foreignKeyName: "balance_check_findings_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "balance_check_findings_consumer_id_fkey"
            columns: ["consumer_id"]
            isOneToOne: false
            referencedRelation: "consumers"
            referencedColumns: ["id"]
          },
        ]
      }
      business_customers: {
        Row: {
          business_id: string
          consumer_id: string
          created_at: string
          created_by: string | null
          first_visit_at: string | null
          id: string
          last_visit_at: string | null
          lifetime_points: number
          lifetime_spend_centavos: number
          notes: string | null
          points_balance: number
          segment: string
          updated_at: string
          updated_by: string | null
          visit_count: number
        }
        Insert: {
          business_id: string
          consumer_id: string
          created_at?: string
          created_by?: string | null
          first_visit_at?: string | null
          id?: string
          last_visit_at?: string | null
          lifetime_points?: number
          lifetime_spend_centavos?: number
          notes?: string | null
          points_balance?: number
          segment?: string
          updated_at?: string
          updated_by?: string | null
          visit_count?: number
        }
        Update: {
          business_id?: string
          consumer_id?: string
          created_at?: string
          created_by?: string | null
          first_visit_at?: string | null
          id?: string
          last_visit_at?: string | null
          lifetime_points?: number
          lifetime_spend_centavos?: number
          notes?: string | null
          points_balance?: number
          segment?: string
          updated_at?: string
          updated_by?: string | null
          visit_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "business_customers_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_customers_consumer_id_fkey"
            columns: ["consumer_id"]
            isOneToOne: false
            referencedRelation: "consumers"
            referencedColumns: ["id"]
          },
        ]
      }
      business_documents: {
        Row: {
          business_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          doc_type: string
          expires_on: string | null
          file_name: string
          id: string
          mime_type: string
          size_bytes: number
          storage_path: string
          updated_at: string
          updated_by: string | null
          verification_id: string | null
        }
        Insert: {
          business_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          doc_type: string
          expires_on?: string | null
          file_name: string
          id?: string
          mime_type: string
          size_bytes: number
          storage_path: string
          updated_at?: string
          updated_by?: string | null
          verification_id?: string | null
        }
        Update: {
          business_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          doc_type?: string
          expires_on?: string | null
          file_name?: string
          id?: string
          mime_type?: string
          size_bytes?: number
          storage_path?: string
          updated_at?: string
          updated_by?: string | null
          verification_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "business_documents_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_documents_verification_id_fkey"
            columns: ["verification_id"]
            isOneToOne: false
            referencedRelation: "business_verifications"
            referencedColumns: ["id"]
          },
        ]
      }
      business_food_types: {
        Row: {
          business_id: string
          food_type_id: string
        }
        Insert: {
          business_id: string
          food_type_id: string
        }
        Update: {
          business_id?: string
          food_type_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_food_types_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_food_types_food_type_id_fkey"
            columns: ["food_type_id"]
            isOneToOne: false
            referencedRelation: "ref_food_types"
            referencedColumns: ["id"]
          },
        ]
      }
      business_merchant_aliases: {
        Row: {
          alias: string
          alias_normalized: string | null
          business_id: string
          created_at: string
          created_by: string | null
          id: string
          receipt_id: string | null
          source: string
        }
        Insert: {
          alias: string
          alias_normalized?: string | null
          business_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          receipt_id?: string | null
          source?: string
        }
        Update: {
          alias?: string
          alias_normalized?: string | null
          business_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          receipt_id?: string | null
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_merchant_aliases_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_merchant_aliases_receipt_id_fkey"
            columns: ["receipt_id"]
            isOneToOne: false
            referencedRelation: "receipts"
            referencedColumns: ["id"]
          },
        ]
      }
      business_staff: {
        Row: {
          business_id: string
          created_at: string
          created_by: string | null
          id: string
          invite_expires_at: string | null
          invite_token: string | null
          invited_email: string | null
          role: string
          status: string
          updated_at: string
          updated_by: string | null
          user_id: string
        }
        Insert: {
          business_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          invite_expires_at?: string | null
          invite_token?: string | null
          invited_email?: string | null
          role: string
          status?: string
          updated_at?: string
          updated_by?: string | null
          user_id: string
        }
        Update: {
          business_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          invite_expires_at?: string | null
          invite_token?: string | null
          invited_email?: string | null
          role?: string
          status?: string
          updated_at?: string
          updated_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_staff_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_staff_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      business_verifications: {
        Row: {
          business_id: string
          created_at: string
          created_by: string | null
          decided_at: string | null
          decided_by: string | null
          decision_reason: string | null
          id: string
          notes: string | null
          registered_name: string | null
          registration_type: string | null
          status: string
          tin_encrypted: string | null
          tin_masked: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          business_id: string
          created_at?: string
          created_by?: string | null
          decided_at?: string | null
          decided_by?: string | null
          decision_reason?: string | null
          id?: string
          notes?: string | null
          registered_name?: string | null
          registration_type?: string | null
          status?: string
          tin_encrypted?: string | null
          tin_masked?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          business_id?: string
          created_at?: string
          created_by?: string | null
          decided_at?: string | null
          decided_by?: string | null
          decision_reason?: string | null
          id?: string
          notes?: string | null
          registered_name?: string | null
          registration_type?: string | null
          status?: string
          tin_encrypted?: string | null
          tin_masked?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "business_verifications_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_verifications_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      businesses: {
        Row: {
          address_line: string | null
          barangay: string | null
          business_type_id: string
          city_id: string | null
          cover_url: string | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          description: string | null
          email: string | null
          gallery: Json
          google_place_id: string | null
          id: string
          lat: number | null
          lng: number | null
          logo_url: string | null
          name: string
          opening_hours: Json
          phone: string | null
          plan: string
          plan_limits: Json
          postal_code: string | null
          search_tsv: unknown
          slug: string
          socials: Json
          status: string
          suspended_reason: string | null
          updated_at: string
          updated_by: string | null
          verified_at: string | null
          website: string | null
        }
        Insert: {
          address_line?: string | null
          barangay?: string | null
          business_type_id: string
          city_id?: string | null
          cover_url?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          email?: string | null
          gallery?: Json
          google_place_id?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          logo_url?: string | null
          name: string
          opening_hours?: Json
          phone?: string | null
          plan?: string
          plan_limits?: Json
          postal_code?: string | null
          search_tsv?: unknown
          slug: string
          socials?: Json
          status?: string
          suspended_reason?: string | null
          updated_at?: string
          updated_by?: string | null
          verified_at?: string | null
          website?: string | null
        }
        Update: {
          address_line?: string | null
          barangay?: string | null
          business_type_id?: string
          city_id?: string | null
          cover_url?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          email?: string | null
          gallery?: Json
          google_place_id?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          logo_url?: string | null
          name?: string
          opening_hours?: Json
          phone?: string | null
          plan?: string
          plan_limits?: Json
          postal_code?: string | null
          search_tsv?: unknown
          slug?: string
          socials?: Json
          status?: string
          suspended_reason?: string | null
          updated_at?: string
          updated_by?: string | null
          verified_at?: string | null
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "businesses_business_type_id_fkey"
            columns: ["business_type_id"]
            isOneToOne: false
            referencedRelation: "ref_business_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "businesses_city_id_fkey"
            columns: ["city_id"]
            isOneToOne: false
            referencedRelation: "ref_cities"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          archived_at: string | null
          audience: Json
          budget: Json
          business_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          description: string | null
          ends_at: string | null
          id: string
          image_url: string | null
          is_stackable: boolean
          name: string
          priority: number
          recurrence: Json | null
          starts_at: string | null
          status: string
          timezone: string
          type: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          archived_at?: string | null
          audience?: Json
          budget?: Json
          business_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          ends_at?: string | null
          id?: string
          image_url?: string | null
          is_stackable?: boolean
          name: string
          priority?: number
          recurrence?: Json | null
          starts_at?: string | null
          status?: string
          timezone?: string
          type: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          archived_at?: string | null
          audience?: Json
          budget?: Json
          business_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          ends_at?: string | null
          id?: string
          image_url?: string | null
          is_stackable?: boolean
          name?: string
          priority?: number
          recurrence?: Json | null
          starts_at?: string | null
          status?: string
          timezone?: string
          type?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      consumers: {
        Row: {
          city_id: string | null
          created_at: string
          created_by: string | null
          email_enabled: boolean
          gps_fraud_opt_in: boolean
          id: string
          last_scan_at: string | null
          lifetime_points_earned: number
          marketing_opt_in: boolean
          push_enabled: boolean
          referral_code: string
          referred_by: string | null
          scan_blocked_until: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          city_id?: string | null
          created_at?: string
          created_by?: string | null
          email_enabled?: boolean
          gps_fraud_opt_in?: boolean
          id: string
          last_scan_at?: string | null
          lifetime_points_earned?: number
          marketing_opt_in?: boolean
          push_enabled?: boolean
          referral_code?: string
          referred_by?: string | null
          scan_blocked_until?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          city_id?: string | null
          created_at?: string
          created_by?: string | null
          email_enabled?: boolean
          gps_fraud_opt_in?: boolean
          id?: string
          last_scan_at?: string | null
          lifetime_points_earned?: number
          marketing_opt_in?: boolean
          push_enabled?: boolean
          referral_code?: string
          referred_by?: string | null
          scan_blocked_until?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "consumers_city_id_fkey"
            columns: ["city_id"]
            isOneToOne: false
            referencedRelation: "ref_cities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consumers_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consumers_referred_by_fkey"
            columns: ["referred_by"]
            isOneToOne: false
            referencedRelation: "consumers"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_flags: {
        Row: {
          created_at: string
          created_by: string | null
          description: string
          is_enabled: boolean
          key: string
          rollout: Json
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description: string
          is_enabled?: boolean
          key: string
          rollout?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string
          is_enabled?: boolean
          key?: string
          rollout?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      fraud_signals: {
        Row: {
          business_id: string | null
          consumer_id: string
          created_at: string
          evidence: Json
          id: string
          receipt_id: string
          score: number
          severity: string
          signal: string
        }
        Insert: {
          business_id?: string | null
          consumer_id: string
          created_at?: string
          evidence?: Json
          id?: string
          receipt_id: string
          score: number
          severity: string
          signal: string
        }
        Update: {
          business_id?: string | null
          consumer_id?: string
          created_at?: string
          evidence?: Json
          id?: string
          receipt_id?: string
          score?: number
          severity?: string
          signal?: string
        }
        Relationships: [
          {
            foreignKeyName: "fraud_signals_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fraud_signals_consumer_id_fkey"
            columns: ["consumer_id"]
            isOneToOne: false
            referencedRelation: "consumers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fraud_signals_receipt_business_fkey"
            columns: ["receipt_id", "business_id"]
            isOneToOne: false
            referencedRelation: "receipts"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "fraud_signals_receipt_id_fkey"
            columns: ["receipt_id"]
            isOneToOne: false
            referencedRelation: "receipts"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_connections: {
        Row: {
          access_token_encrypted: string
          business_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          error: string | null
          external_account_id: string
          external_account_name: string | null
          id: string
          last_synced_at: string | null
          provider: string
          refresh_token_encrypted: string | null
          scopes: string[]
          status: string
          token_expires_at: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          access_token_encrypted: string
          business_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          error?: string | null
          external_account_id: string
          external_account_name?: string | null
          id?: string
          last_synced_at?: string | null
          provider: string
          refresh_token_encrypted?: string | null
          scopes?: string[]
          status?: string
          token_expires_at?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          access_token_encrypted?: string
          business_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          error?: string | null
          external_account_id?: string
          external_account_name?: string | null
          id?: string
          last_synced_at?: string | null
          provider?: string
          refresh_token_encrypted?: string | null
          scopes?: string[]
          status?: string
          token_expires_at?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "integration_connections_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      job_alert_state: {
        Row: {
          jobname: string
          last_alerted_at: string
          last_detail: string | null
          since: string
          updated_at: string
        }
        Insert: {
          jobname: string
          last_alerted_at: string
          last_detail?: string | null
          since: string
          updated_at?: string
        }
        Update: {
          jobname?: string
          last_alerted_at?: string
          last_detail?: string | null
          since?: string
          updated_at?: string
        }
        Relationships: []
      }
      jobs: {
        Row: {
          attempts: number
          business_id: string | null
          created_at: string
          dedupe_key: string | null
          finished_at: string | null
          heartbeat_at: string | null
          id: string
          last_error: string | null
          max_attempts: number
          payload: Json
          qstash_message_id: string | null
          queue: string
          scheduled_at: string
          started_at: string | null
          status: string
        }
        Insert: {
          attempts?: number
          business_id?: string | null
          created_at?: string
          dedupe_key?: string | null
          finished_at?: string | null
          heartbeat_at?: string | null
          id?: string
          last_error?: string | null
          max_attempts?: number
          payload: Json
          qstash_message_id?: string | null
          queue: string
          scheduled_at?: string
          started_at?: string | null
          status?: string
        }
        Update: {
          attempts?: number
          business_id?: string | null
          created_at?: string
          dedupe_key?: string | null
          finished_at?: string | null
          heartbeat_at?: string | null
          id?: string
          last_error?: string | null
          max_attempts?: number
          payload?: Json
          qstash_message_id?: string | null
          queue?: string
          scheduled_at?: string
          started_at?: string | null
          status?: string
        }
        Relationships: []
      }
      loyalty_cards: {
        Row: {
          business_id: string
          completed_count: number
          consumer_id: string
          created_at: string
          created_by: string | null
          id: string
          last_stamp_at: string | null
          program_id: string
          progress: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          business_id: string
          completed_count?: number
          consumer_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          last_stamp_at?: string | null
          program_id: string
          progress?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          business_id?: string
          completed_count?: number
          consumer_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          last_stamp_at?: string | null
          program_id?: string
          progress?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_cards_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_cards_consumer_id_fkey"
            columns: ["consumer_id"]
            isOneToOne: false
            referencedRelation: "consumers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_cards_program_business_fkey"
            columns: ["program_id", "business_id"]
            isOneToOne: false
            referencedRelation: "loyalty_programs"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      loyalty_programs: {
        Row: {
          business_id: string
          campaign_id: string
          card_style: Json
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          max_stamps_per_day: number
          min_amount_per_stamp_centavos: number | null
          program_type: string
          resets_on_completion: boolean
          reward_id: string
          stamp_icon: string | null
          target_value: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          business_id: string
          campaign_id: string
          card_style?: Json
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          max_stamps_per_day?: number
          min_amount_per_stamp_centavos?: number | null
          program_type: string
          resets_on_completion?: boolean
          reward_id: string
          stamp_icon?: string | null
          target_value: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          business_id?: string
          campaign_id?: string
          card_style?: Json
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          max_stamps_per_day?: number
          min_amount_per_stamp_centavos?: number | null
          program_type?: string
          resets_on_completion?: boolean
          reward_id?: string
          stamp_icon?: string | null
          target_value?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_programs_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_programs_campaign_business_fkey"
            columns: ["campaign_id", "business_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "loyalty_programs_reward_business_fkey"
            columns: ["reward_id", "business_id"]
            isOneToOne: false
            referencedRelation: "rewards"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      menu_categories: {
        Row: {
          business_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          description: string | null
          id: string
          is_active: boolean
          name: string
          sort: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          business_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          sort?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          business_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          sort?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "menu_categories_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string
          business_id: string | null
          channel: string
          created_at: string
          data: Json
          error: string | null
          id: string
          kind: string
          read_at: string | null
          sent_at: string | null
          status: string
          title: string
          user_id: string
        }
        Insert: {
          body: string
          business_id?: string | null
          channel?: string
          created_at?: string
          data?: Json
          error?: string | null
          id?: string
          kind: string
          read_at?: string | null
          sent_at?: string | null
          status?: string
          title: string
          user_id: string
        }
        Update: {
          body?: string
          business_id?: string | null
          channel?: string
          created_at?: string
          data?: Json
          error?: string | null
          id?: string
          kind?: string
          read_at?: string | null
          sent_at?: string | null
          status?: string
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ocr_results: {
        Row: {
          attempt: number
          blocks: Json | null
          created_at: string
          duration_ms: number | null
          engine: string
          engine_version: string
          error: string | null
          id: string
          mean_confidence: number | null
          preprocess_ops: string[] | null
          raw_text: string | null
          receipt_id: string
        }
        Insert: {
          attempt?: number
          blocks?: Json | null
          created_at?: string
          duration_ms?: number | null
          engine?: string
          engine_version: string
          error?: string | null
          id?: string
          mean_confidence?: number | null
          preprocess_ops?: string[] | null
          raw_text?: string | null
          receipt_id: string
        }
        Update: {
          attempt?: number
          blocks?: Json | null
          created_at?: string
          duration_ms?: number | null
          engine?: string
          engine_version?: string
          error?: string | null
          id?: string
          mean_confidence?: number | null
          preprocess_ops?: string[] | null
          raw_text?: string | null
          receipt_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ocr_results_receipt_id_fkey"
            columns: ["receipt_id"]
            isOneToOne: false
            referencedRelation: "receipts"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_admins: {
        Row: {
          created_at: string
          created_by: string | null
          is_active: boolean
          mfa_enforced: boolean
          role: string
          updated_at: string
          updated_by: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          is_active?: boolean
          mfa_enforced?: boolean
          role: string
          updated_at?: string
          updated_by?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          is_active?: boolean
          mfa_enforced?: boolean
          role?: string
          updated_at?: string
          updated_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_admins_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      points_rules: {
        Row: {
          bonus_points: number | null
          business_id: string
          campaign_id: string | null
          conditions: Json
          created_at: string
          created_by: string | null
          deleted_at: string | null
          fixed_points: number | null
          id: string
          is_active: boolean
          kind: string
          multiplier: number | null
          rate_centavos_per_point: number | null
          rounding: string
          rule_type: string
          tiers: Json | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          bonus_points?: number | null
          business_id: string
          campaign_id?: string | null
          conditions?: Json
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          fixed_points?: number | null
          id?: string
          is_active?: boolean
          kind: string
          multiplier?: number | null
          rate_centavos_per_point?: number | null
          rounding?: string
          rule_type: string
          tiers?: Json | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          bonus_points?: number | null
          business_id?: string
          campaign_id?: string | null
          conditions?: Json
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          fixed_points?: number | null
          id?: string
          is_active?: boolean
          kind?: string
          multiplier?: number | null
          rate_centavos_per_point?: number | null
          rounding?: string
          rule_type?: string
          tiers?: Json | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "points_rules_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "points_rules_campaign_business_fkey"
            columns: ["campaign_id", "business_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      points_transactions: {
        Row: {
          actor_id: string | null
          adjust_reason: string | null
          balance_after: number
          business_id: string
          campaign_id: string | null
          claim_id: string | null
          consumer_id: string
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          points: number
          receipt_id: string | null
          reverses_id: string | null
          rule_snapshot: Json | null
          type: string
        }
        Insert: {
          actor_id?: string | null
          adjust_reason?: string | null
          balance_after: number
          business_id: string
          campaign_id?: string | null
          claim_id?: string | null
          consumer_id: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          points: number
          receipt_id?: string | null
          reverses_id?: string | null
          rule_snapshot?: Json | null
          type: string
        }
        Update: {
          actor_id?: string | null
          adjust_reason?: string | null
          balance_after?: number
          business_id?: string
          campaign_id?: string | null
          claim_id?: string | null
          consumer_id?: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          points?: number
          receipt_id?: string | null
          reverses_id?: string | null
          rule_snapshot?: Json | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "points_transactions_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "points_transactions_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "points_transactions_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "points_transactions_claim_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "reward_claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "points_transactions_consumer_id_fkey"
            columns: ["consumer_id"]
            isOneToOne: false
            referencedRelation: "consumers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "points_transactions_receipt_fkey"
            columns: ["receipt_id"]
            isOneToOne: false
            referencedRelation: "receipts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "points_transactions_reverses_id_fkey"
            columns: ["reverses_id"]
            isOneToOne: false
            referencedRelation: "points_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      product_addons: {
        Row: {
          business_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          is_available: boolean
          name: string
          price_delta_centavos: number
          product_id: string
          sort: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          business_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          is_available?: boolean
          name: string
          price_delta_centavos?: number
          product_id: string
          sort?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          business_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          is_available?: boolean
          name?: string
          price_delta_centavos?: number
          product_id?: string
          sort?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_addons_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_addons_product_business_fkey"
            columns: ["product_id", "business_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      product_variants: {
        Row: {
          business_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          is_available: boolean
          name: string
          price_centavos: number
          product_id: string
          sort: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          business_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          is_available?: boolean
          name: string
          price_centavos: number
          product_id: string
          sort?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          business_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          is_available?: boolean
          name?: string
          price_centavos?: number
          product_id?: string
          sort?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_variants_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_variants_product_business_fkey"
            columns: ["product_id", "business_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      products: {
        Row: {
          availability: Json
          base_price_centavos: number
          business_id: string
          category_id: string | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          description: string | null
          id: string
          images: Json
          is_available: boolean
          name: string
          search_tsv: unknown
          sort: number
          status: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          availability?: Json
          base_price_centavos: number
          business_id: string
          category_id?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          images?: Json
          is_available?: boolean
          name: string
          search_tsv?: unknown
          sort?: number
          status?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          availability?: Json
          base_price_centavos?: number
          business_id?: string
          category_id?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          images?: Json
          is_available?: boolean
          name?: string
          search_tsv?: unknown
          sort?: number
          status?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "products_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_category_business_fkey"
            columns: ["category_id", "business_id"]
            isOneToOne: false
            referencedRelation: "menu_categories"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          birth_date: string | null
          birth_date_updated_at: string | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          display_name: string
          id: string
          is_suspended: boolean
          locale: string
          onboarded_at: string | null
          phone: string | null
          suspended_reason: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          avatar_url?: string | null
          birth_date?: string | null
          birth_date_updated_at?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          display_name: string
          id: string
          is_suspended?: boolean
          locale?: string
          onboarded_at?: string | null
          phone?: string | null
          suspended_reason?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          avatar_url?: string | null
          birth_date?: string | null
          birth_date_updated_at?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          display_name?: string
          id?: string
          is_suspended?: boolean
          locale?: string
          onboarded_at?: string | null
          phone?: string | null
          suspended_reason?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      promotions: {
        Row: {
          amount_off_centavos: number | null
          business_id: string
          campaign_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          freebie_text: string | null
          id: string
          offer_kind: string
          percent_off: number | null
          product_ids: string[]
          redemption_hint: string | null
          terms: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          amount_off_centavos?: number | null
          business_id: string
          campaign_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          freebie_text?: string | null
          id?: string
          offer_kind: string
          percent_off?: number | null
          product_ids?: string[]
          redemption_hint?: string | null
          terms?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          amount_off_centavos?: number | null
          business_id?: string
          campaign_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          freebie_text?: string | null
          id?: string
          offer_kind?: string
          percent_off?: number | null
          product_ids?: string[]
          redemption_hint?: string | null
          terms?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "promotions_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promotions_campaign_business_fkey"
            columns: ["campaign_id", "business_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      receipt_line_items: {
        Row: {
          business_id: string | null
          id: string
          line_total_centavos: number | null
          match_score: number | null
          product_id: string | null
          qty: number | null
          raw_text: string
          receipt_id: string
          sort: number
          unit_price_centavos: number | null
        }
        Insert: {
          business_id?: string | null
          id?: string
          line_total_centavos?: number | null
          match_score?: number | null
          product_id?: string | null
          qty?: number | null
          raw_text: string
          receipt_id: string
          sort?: number
          unit_price_centavos?: number | null
        }
        Update: {
          business_id?: string | null
          id?: string
          line_total_centavos?: number | null
          match_score?: number | null
          product_id?: string | null
          qty?: number | null
          raw_text?: string
          receipt_id?: string
          sort?: number
          unit_price_centavos?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "receipt_line_items_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receipt_line_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receipt_line_items_receipt_id_fkey"
            columns: ["receipt_id"]
            isOneToOne: false
            referencedRelation: "receipts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rli_receipt_business_fkey"
            columns: ["receipt_id", "business_id"]
            isOneToOne: false
            referencedRelation: "receipts"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      receipt_templates: {
        Row: {
          business_id: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          embedding: string | null
          id: string
          is_active: boolean
          layout_text: string | null
          name: string
          ocr_test_result: Json | null
          parse_config: Json
          sample_path: string
          source_kind: string
          updated_at: string
          updated_by: string | null
          validated_at: string | null
          version: number
        }
        Insert: {
          business_id: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          embedding?: string | null
          id?: string
          is_active?: boolean
          layout_text?: string | null
          name: string
          ocr_test_result?: Json | null
          parse_config?: Json
          sample_path: string
          source_kind?: string
          updated_at?: string
          updated_by?: string | null
          validated_at?: string | null
          version?: number
        }
        Update: {
          business_id?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          embedding?: string | null
          id?: string
          is_active?: boolean
          layout_text?: string | null
          name?: string
          ocr_test_result?: Json | null
          parse_config?: Json
          sample_path?: string
          source_kind?: string
          updated_at?: string
          updated_by?: string | null
          validated_at?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "receipt_templates_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      receipts: {
        Row: {
          business_id: string | null
          created_at: string
          created_by: string | null
          device_id: string | null
          escalated_at: string | null
          id: string
          image_hash: string
          image_path: string
          match_confidence: number | null
          merchant_name: string | null
          parse_confidence: number | null
          parse_meta: Json | null
          processed_at: string | null
          receipt_date: string | null
          receipt_number: string | null
          reject_note: string | null
          reject_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          sha256: string
          source: string
          status: string
          submitted_lat: number | null
          submitted_lng: number | null
          subtotal_centavos: number | null
          tax_centavos: number | null
          template_id: string | null
          total_centavos: number | null
          updated_at: string
          updated_by: string | null
          user_id: string
          visit_recorded_at: string | null
        }
        Insert: {
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          device_id?: string | null
          escalated_at?: string | null
          id?: string
          image_hash: string
          image_path: string
          match_confidence?: number | null
          merchant_name?: string | null
          parse_confidence?: number | null
          parse_meta?: Json | null
          processed_at?: string | null
          receipt_date?: string | null
          receipt_number?: string | null
          reject_note?: string | null
          reject_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sha256: string
          source?: string
          status?: string
          submitted_lat?: number | null
          submitted_lng?: number | null
          subtotal_centavos?: number | null
          tax_centavos?: number | null
          template_id?: string | null
          total_centavos?: number | null
          updated_at?: string
          updated_by?: string | null
          user_id: string
          visit_recorded_at?: string | null
        }
        Update: {
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          device_id?: string | null
          escalated_at?: string | null
          id?: string
          image_hash?: string
          image_path?: string
          match_confidence?: number | null
          merchant_name?: string | null
          parse_confidence?: number | null
          parse_meta?: Json | null
          processed_at?: string | null
          receipt_date?: string | null
          receipt_number?: string | null
          reject_note?: string | null
          reject_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sha256?: string
          source?: string
          status?: string
          submitted_lat?: number | null
          submitted_lng?: number | null
          subtotal_centavos?: number | null
          tax_centavos?: number | null
          template_id?: string | null
          total_centavos?: number | null
          updated_at?: string
          updated_by?: string | null
          user_id?: string
          visit_recorded_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "receipts_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receipts_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "user_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receipts_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receipts_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "receipt_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receipts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "consumers"
            referencedColumns: ["id"]
          },
        ]
      }
      redemptions: {
        Row: {
          business_id: string
          claim_id: string
          created_at: string
          created_by: string | null
          id: string
          method: string
          redeemed_at: string
          token_jti: string | null
          updated_at: string
          updated_by: string | null
          validated_by: string
        }
        Insert: {
          business_id: string
          claim_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          method?: string
          redeemed_at?: string
          token_jti?: string | null
          updated_at?: string
          updated_by?: string | null
          validated_by: string
        }
        Update: {
          business_id?: string
          claim_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          method?: string
          redeemed_at?: string
          token_jti?: string | null
          updated_at?: string
          updated_by?: string | null
          validated_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "redemptions_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "redemptions_claim_business_fkey"
            columns: ["claim_id", "business_id"]
            isOneToOne: false
            referencedRelation: "reward_claims"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "redemptions_validated_by_fkey"
            columns: ["validated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ref_business_types: {
        Row: {
          created_at: string
          created_by: string | null
          icon: string | null
          id: string
          is_active: boolean
          name: string
          slug: string
          sort: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          name: string
          slug: string
          sort?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          name?: string
          slug?: string
          sort?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      ref_cities: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          name: string
          province: string
          region: string
          slug: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          name: string
          province: string
          region: string
          slug: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          name?: string
          province?: string
          region?: string
          slug?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      ref_food_types: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          name: string
          slug: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          name: string
          slug: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          name?: string
          slug?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      reward_claims: {
        Row: {
          business_id: string
          cancelled_reason: string | null
          claimed_at: string
          consumer_id: string
          created_at: string
          created_by: string | null
          expires_at: string
          id: string
          points_spent: number
          points_txn_id: string | null
          redeemed_at: string | null
          reward_id: string
          status: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          business_id: string
          cancelled_reason?: string | null
          claimed_at?: string
          consumer_id: string
          created_at?: string
          created_by?: string | null
          expires_at: string
          id?: string
          points_spent?: number
          points_txn_id?: string | null
          redeemed_at?: string | null
          reward_id: string
          status?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          business_id?: string
          cancelled_reason?: string | null
          claimed_at?: string
          consumer_id?: string
          created_at?: string
          created_by?: string | null
          expires_at?: string
          id?: string
          points_spent?: number
          points_txn_id?: string | null
          redeemed_at?: string | null
          reward_id?: string
          status?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reward_claims_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reward_claims_consumer_id_fkey"
            columns: ["consumer_id"]
            isOneToOne: false
            referencedRelation: "consumers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reward_claims_points_txn_fkey"
            columns: ["points_txn_id"]
            isOneToOne: false
            referencedRelation: "points_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reward_claims_reward_business_fkey"
            columns: ["reward_id", "business_id"]
            isOneToOne: false
            referencedRelation: "rewards"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      rewards: {
        Row: {
          business_id: string
          campaign_id: string
          claim_expiry_days: number
          claim_kind: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          description: string | null
          id: string
          image_url: string | null
          is_active: boolean
          name: string
          per_customer_limit: number
          points_cost: number
          remaining: number | null
          terms: string | null
          total_inventory: number | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          business_id: string
          campaign_id: string
          claim_expiry_days?: number
          claim_kind?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          name: string
          per_customer_limit?: number
          points_cost?: number
          remaining?: number | null
          terms?: string | null
          total_inventory?: number | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          business_id?: string
          campaign_id?: string
          claim_expiry_days?: number
          claim_kind?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          name?: string
          per_customer_limit?: number
          points_cost?: number
          remaining?: number | null
          terms?: string | null
          total_inventory?: number | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rewards_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rewards_campaign_business_fkey"
            columns: ["campaign_id", "business_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      settings: {
        Row: {
          business_id: string | null
          created_at: string
          created_by: string | null
          id: string
          key: string
          scope: string
          updated_at: string
          updated_by: string | null
          value: Json
        }
        Insert: {
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          key: string
          scope: string
          updated_at?: string
          updated_by?: string | null
          value: Json
        }
        Update: {
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          key?: string
          scope?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "settings_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      user_consents: {
        Row: {
          consented_at: string
          id: string
          ip: unknown
          page_slug: string
          user_id: string
          version: number
        }
        Insert: {
          consented_at?: string
          id?: string
          ip?: unknown
          page_slug: string
          user_id: string
          version: number
        }
        Update: {
          consented_at?: string
          id?: string
          ip?: unknown
          page_slug?: string
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "user_consents_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_devices: {
        Row: {
          created_at: string
          created_by: string | null
          fcm_token: string | null
          id: string
          is_revoked: boolean
          last_seen_at: string
          platform: string | null
          updated_at: string
          updated_by: string | null
          user_agent: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          fcm_token?: string | null
          id?: string
          is_revoked?: boolean
          last_seen_at?: string
          platform?: string | null
          updated_at?: string
          updated_by?: string | null
          user_agent?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          fcm_token?: string | null
          id?: string
          is_revoked?: boolean
          last_seen_at?: string
          platform?: string | null
          updated_at?: string
          updated_by?: string | null
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_devices_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      activate_business: {
        Args: {
          p_actor_id: string
          p_business_id: string
          p_reason: string
          p_request_id?: string
        }
        Returns: Json
      }
      award_receipt_points: {
        Args: {
          p_campaign_budget_checks?: Json
          p_campaign_id?: string
          p_expires_at?: string
          p_points: number
          p_receipt_id: string
          p_rule_snapshot?: Json
          p_verify_no_prior_fixed_visit_earn?: boolean
        }
        Returns: string
      }
      balance_check: { Args: { p_limit?: number }; Returns: number }
      balance_check_summary: {
        Args: never
        Returns: {
          checked_count: number
          drifted_count: number
          oldest_checked_at: string
        }[]
      }
      campaign_customer_earn_count: {
        Args: {
          p_business_id: string
          p_campaign_id: string
          p_consumer_id: string
        }
        Returns: number
      }
      campaign_points_awarded: {
        Args: { p_business_id: string; p_campaign_id: string }
        Returns: number
      }
      cancel_claim: { Args: { p_claim_id: string }; Returns: undefined }
      claim_reward: { Args: { p_reward_id: string }; Returns: string }
      clawback_receipt_points: {
        Args: {
          p_actor_id: string
          p_reason: string
          p_receipt_id: string
          p_request_id?: string
        }
        Returns: Json
      }
      expire_claims: { Args: { p_limit?: number }; Returns: number }
      expire_points: { Args: { p_limit?: number }; Returns: number }
      fixed_per_visit_already_paid: {
        Args: {
          p_business_id: string
          p_consumer_id: string
          p_visit_day: string
        }
        Returns: boolean
      }
      points_expirable_remainder: {
        Args: { p_asof?: string; p_business_id: string; p_consumer_id: string }
        Returns: number
      }
      points_expiry_warn: { Args: { p_limit?: number }; Returns: number }
      points_next_expiry: {
        Args: { p_business_id: string; p_consumer_id: string }
        Returns: {
          expires_at: string
          points: number
        }[]
      }
      receipt_routing_breakdown: {
        Args: { p_business_id?: string; p_days?: number }
        Returns: {
          key: string
          kind: string
          tally: number
        }[]
      }
      record_receipt_visit: {
        Args: { p_receipt_id: string }
        Returns: undefined
      }
      register_business: {
        Args: {
          p_address: string
          p_city: string
          p_name: string
          p_type: string
        }
        Returns: string
      }
      reject_business_verification: {
        Args: {
          p_actor_id: string
          p_business_id: string
          p_reason: string
          p_request_id?: string
        }
        Returns: Json
      }
      submit_business_for_review: {
        Args: {
          p_actor_id: string
          p_business_id: string
          p_note?: string
          p_request_id?: string
        }
        Returns: Json
      }
      sweep_campaigns: { Args: { p_limit?: number }; Returns: number }
      sweep_job_health: {
        Args: { p_hours?: number }
        Returns: {
          active: boolean
          failures: number
          jobname: string
          last_error: string
          last_finished_at: string
          last_status: string
          runs: number
          schedule: string
        }[]
      }
      sweep_job_terminal_failures: {
        Args: { p_hours?: number }
        Returns: {
          jobname: string
          last_terminal_error: string
          terminal_failures: number
          terminal_runs: number
        }[]
      }
      sweep_stuck_receipts: { Args: { p_limit?: number }; Returns: number }
      validate_redemption: {
        Args: { p_claim_id: string; p_method?: string; p_token_jti: string }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

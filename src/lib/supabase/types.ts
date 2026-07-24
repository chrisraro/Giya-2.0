// GENERATED FILE: Supabase types for project dcnpuvtbftpbcjcvfnlt.
// Regenerate after schema migrations (MCP generate_typescript_types or
// `supabase gen types typescript`). Do not edit by hand.
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
      register_business: {
        Args: {
          p_address: string
          p_city: string
          p_name: string
          p_type: string
        }
        Returns: string
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

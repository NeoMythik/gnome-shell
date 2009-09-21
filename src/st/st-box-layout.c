/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */
/*
 * st-box-layout.h: box layout actor
 *
 * Copyright 2009 Intel Corporation.
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms and conditions of the GNU Lesser General Public License,
 * version 2.1, as published by the Free Software Foundation.
 *
 * This program is distributed in the hope it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE.  See the GNU Lesser General Public License for
 * more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin St - Fifth Floor, Boston, MA 02110-1301 USA.
 *
 * Written by: Thomas Wood <thomas.wood@intel.com>
 *
 */

/**
 * SECTION:st-box-layout
 * @short_description: a layout container arranging children in a single line
 *
 * The #StBoxLayout arranges its children along a single line, where each
 * child can be allocated either its preferred size or larger if the expand
 * option is set. If the fill option is set, the actor will be allocated more
 * than its requested size. If the fill option is not set, but the expand option
 * is enabled, then the position of the actor within the available space can
 * be determined by the alignment child property.
 *
 */

#include "st-box-layout.h"

#include "st-private.h"
#include "st-scrollable.h"
#include "st-box-layout-child.h"



static void st_box_container_iface_init (ClutterContainerIface *iface);
static void st_box_scrollable_interface_init (StScrollableInterface *iface);

G_DEFINE_TYPE_WITH_CODE (StBoxLayout, st_box_layout, ST_TYPE_WIDGET,
                         G_IMPLEMENT_INTERFACE (CLUTTER_TYPE_CONTAINER,
                                                st_box_container_iface_init)
                         G_IMPLEMENT_INTERFACE (ST_TYPE_SCROLLABLE,
                                                st_box_scrollable_interface_init));

#define BOX_LAYOUT_PRIVATE(o) \
  (G_TYPE_INSTANCE_GET_PRIVATE ((o), ST_TYPE_BOX_LAYOUT, StBoxLayoutPrivate))

enum {
  PROP_0,

  PROP_VERTICAL,
  PROP_PACK_START,
  PROP_SPACING,

  PROP_HADJUST,
  PROP_VADJUST
};

struct _StBoxLayoutPrivate
{
  GList        *children;

  guint         spacing;

  guint         is_vertical : 1;
  guint         is_pack_start : 1;

  StAdjustment *hadjustment;
  StAdjustment *vadjustment;
};

/*
 * StScrollable Interface Implementation
 */
static void
adjustment_value_notify_cb (StAdjustment *adjustment,
                            GParamSpec   *pspec,
                            StBoxLayout  *box)
{
  clutter_actor_queue_redraw (CLUTTER_ACTOR (box));
}

static void
scrollable_set_adjustments (StScrollable *scrollable,
                            StAdjustment *hadjustment,
                            StAdjustment *vadjustment)
{
  StBoxLayoutPrivate *priv = ST_BOX_LAYOUT (scrollable)->priv;

  if (hadjustment != priv->hadjustment)
    {
      if (priv->hadjustment)
        {
          g_signal_handlers_disconnect_by_func (priv->hadjustment,
                                                adjustment_value_notify_cb,
                                                scrollable);
          g_object_unref (priv->hadjustment);
        }

      if (hadjustment)
        {
          g_object_ref (hadjustment);
          g_signal_connect (hadjustment, "notify::value",
                            G_CALLBACK (adjustment_value_notify_cb),
                            scrollable);
        }

      priv->hadjustment = hadjustment;
    }

  if (vadjustment != priv->vadjustment)
    {
      if (priv->vadjustment)
        {
          g_signal_handlers_disconnect_by_func (priv->vadjustment,
                                                adjustment_value_notify_cb,
                                                scrollable);
          g_object_unref (priv->vadjustment);
        }

      if (vadjustment)
        {
          g_object_ref (vadjustment);
          g_signal_connect (vadjustment, "notify::value",
                            G_CALLBACK (adjustment_value_notify_cb),
                            scrollable);
        }

      priv->vadjustment = vadjustment;
    }
}

static void
scrollable_get_adjustments (StScrollable  *scrollable,
                            StAdjustment **hadjustment,
                            StAdjustment **vadjustment)
{
  StBoxLayoutPrivate *priv;
  ClutterActor *actor, *stage;

  priv = (ST_BOX_LAYOUT (scrollable))->priv;

  actor = CLUTTER_ACTOR (scrollable);
  stage = clutter_actor_get_stage (actor);

  if (hadjustment)
    {
      if (priv->hadjustment)
        *hadjustment = priv->hadjustment;
      else
        {
          StAdjustment *adjustment;
          gdouble width, stage_width, increment;

          if (stage)
            {
              width = clutter_actor_get_width (actor);
              stage_width = clutter_actor_get_width (stage);
              increment = MAX (1.0, MIN (stage_width, width));
            }
          else
            {
              width = increment = 1.0;
            }

          adjustment = st_adjustment_new (0,
                                          0,
                                          width,
                                          1.0,
                                          increment,
                                          increment);

          scrollable_set_adjustments (scrollable,
                                      adjustment,
                                      priv->vadjustment);

          *hadjustment = adjustment;
        }
    }

  if (vadjustment)
    {
      if (priv->vadjustment)
        *vadjustment = priv->vadjustment;
      else
        {
          StAdjustment *adjustment;
          gdouble height, stage_height, increment;

          if (stage)
            {
              height = clutter_actor_get_height (actor);
              stage_height = clutter_actor_get_height (stage);
              increment = MAX (1.0, MIN (stage_height, height));
            }
          else
            {
              height = increment = 1.0;
            }

          adjustment = st_adjustment_new (0,
                                          0,
                                          height,
                                          1.0,
                                          increment,
                                          increment);

          scrollable_set_adjustments (scrollable,
                                      priv->hadjustment,
                                      adjustment);

          *vadjustment = adjustment;
        }
    }
}



static void
st_box_scrollable_interface_init (StScrollableInterface *iface)
{
  iface->set_adjustments = scrollable_set_adjustments;
  iface->get_adjustments = scrollable_get_adjustments;
}

/*
 * ClutterContainer Implementation
 */
static void
st_box_container_add_actor (ClutterContainer *container,
                            ClutterActor     *actor)
{
  StBoxLayoutPrivate *priv = ST_BOX_LAYOUT (container)->priv;

  clutter_actor_set_parent (actor, CLUTTER_ACTOR (container));

  priv->children = g_list_append (priv->children, actor);

  g_signal_emit_by_name (container, "actor-added", actor);
}

static void
st_box_container_remove_actor (ClutterContainer *container,
                               ClutterActor     *actor)
{
  StBoxLayoutPrivate *priv = ST_BOX_LAYOUT (container)->priv;

  GList *item = NULL;

  item = g_list_find (priv->children, actor);

  if (item == NULL)
    {
      g_warning ("Actor of type '%s' is not a child of container of type '%s'",
                 g_type_name (G_OBJECT_TYPE (actor)),
                 g_type_name (G_OBJECT_TYPE (container)));
      return;
    }

  g_object_ref (actor);

  priv->children = g_list_delete_link (priv->children, item);
  clutter_actor_unparent (actor);

  g_signal_emit_by_name (container, "actor-removed", actor);

  g_object_unref (actor);

  clutter_actor_queue_relayout ((ClutterActor*) container);
}

static void
st_box_container_foreach (ClutterContainer *container,
                          ClutterCallback   callback,
                          gpointer          callback_data)
{
  StBoxLayoutPrivate *priv = ST_BOX_LAYOUT (container)->priv;

  g_list_foreach (priv->children, (GFunc) callback, callback_data);
}

static void
st_box_container_lower (ClutterContainer *container,
                        ClutterActor     *actor,
                        ClutterActor     *sibling)
{
  /* XXX: not yet implemented */
  g_warning ("%s() not yet implemented", __FUNCTION__);
}

static void
st_box_container_raise (ClutterContainer *container,
                        ClutterActor     *actor,
                        ClutterActor     *sibling)
{
  /* XXX: not yet implemented */
  g_warning ("%s() not yet implemented", __FUNCTION__);
}

static void
st_box_container_sort_depth_order (ClutterContainer *container)
{
  /* XXX: not yet implemented */
  g_warning ("%s() not yet implemented", __FUNCTION__);
}

static void
st_box_container_iface_init (ClutterContainerIface *iface)
{
  iface->add = st_box_container_add_actor;
  iface->remove = st_box_container_remove_actor;
  iface->foreach = st_box_container_foreach;
  iface->lower = st_box_container_lower;
  iface->raise = st_box_container_raise;
  iface->sort_depth_order = st_box_container_sort_depth_order;

  iface->child_meta_type = ST_TYPE_BOX_LAYOUT_CHILD;
}


static void
st_box_layout_get_property (GObject    *object,
                            guint       property_id,
                            GValue     *value,
                            GParamSpec *pspec)
{
  StBoxLayoutPrivate *priv = ST_BOX_LAYOUT (object)->priv;
  StAdjustment *adjustment;

  switch (property_id)
    {
    case PROP_VERTICAL:
      g_value_set_boolean (value, priv->is_vertical);
      break;

    case PROP_PACK_START:
      g_value_set_boolean (value, priv->is_pack_start);
      break;

    case PROP_SPACING:
      g_value_set_uint (value, priv->spacing);
      break;

    case PROP_HADJUST:
      scrollable_get_adjustments (ST_SCROLLABLE (object), &adjustment, NULL);
      g_value_set_object (value, adjustment);
      break;

    case PROP_VADJUST:
      scrollable_get_adjustments (ST_SCROLLABLE (object), NULL, &adjustment);
      g_value_set_object (value, adjustment);
      break;

    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (object, property_id, pspec);
    }
}

static void
st_box_layout_set_property (GObject      *object,
                            guint         property_id,
                            const GValue *value,
                            GParamSpec   *pspec)
{
  StBoxLayout *box = ST_BOX_LAYOUT (object);

  switch (property_id)
    {
    case PROP_VERTICAL:
      st_box_layout_set_vertical (box, g_value_get_boolean (value));
      break;

    case PROP_PACK_START:
      st_box_layout_set_pack_start (box, g_value_get_boolean (value));
      break;

    case PROP_SPACING:
      st_box_layout_set_spacing (box, g_value_get_uint (value));
      break;

    case PROP_HADJUST:
      scrollable_set_adjustments (ST_SCROLLABLE (object),
                                  g_value_get_object (value),
                                  box->priv->vadjustment);
      break;

    case PROP_VADJUST:
      scrollable_set_adjustments (ST_SCROLLABLE (object),
                                  box->priv->hadjustment,
                                  g_value_get_object (value));
      break;

    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (object, property_id, pspec);
    }
}

static void
st_box_layout_dispose (GObject *object)
{
  StBoxLayoutPrivate *priv = ST_BOX_LAYOUT (object)->priv;

  while (priv->children)
    {
      clutter_actor_unparent (CLUTTER_ACTOR (priv->children->data));

      priv->children = g_list_delete_link (priv->children, priv->children);
    }

  if (priv->hadjustment)
    {
      g_object_unref (priv->hadjustment);
      priv->hadjustment = NULL;
    }

  if (priv->vadjustment)
    {
      g_object_unref (priv->vadjustment);
      priv->vadjustment = NULL;
    }

  G_OBJECT_CLASS (st_box_layout_parent_class)->dispose (object);
}

static void
get_content_preferred_width (StBoxLayout *self,
                             gfloat       for_height,
                             gfloat      *min_width_p,
                             gfloat      *natural_width_p)
{
  StBoxLayoutPrivate *priv = self->priv;
  gint n_children = 0;
  gfloat min_width, natural_width;
  GList *l;

  min_width = 0;
  natural_width = 0;

  for (l = priv->children; l; l = g_list_next (l))
    {
      gfloat child_min = 0, child_nat = 0;

      if (!CLUTTER_ACTOR_IS_VISIBLE ((ClutterActor*) l->data))
        continue;

      n_children++;

      clutter_actor_get_preferred_width ((ClutterActor*) l->data,
                                         (!priv->is_vertical) ? for_height : -1,
                                         &child_min,
                                         &child_nat);

      if (priv->is_vertical)
        {
          min_width = MAX (child_min, min_width);
          natural_width = MAX (child_nat, natural_width);
        }
      else
        {
          min_width += child_min;
          natural_width += child_nat;
        }
    }

  if (!priv->is_vertical && n_children > 1)
    {
      min_width += priv->spacing * (n_children - 1);
      natural_width += priv->spacing * (n_children - 1);
    }

  if (min_width_p)
    *min_width_p = min_width;

  if (natural_width_p)
    *natural_width_p = natural_width;
}

static void
st_box_layout_get_preferred_width (ClutterActor *actor,
                                   gfloat        for_height,
                                   gfloat       *min_width_p,
                                   gfloat       *natural_width_p)
{
  StThemeNode *theme_node = st_widget_get_theme_node (ST_WIDGET (actor));

  st_theme_node_adjust_for_height (theme_node, &for_height);

  get_content_preferred_width (ST_BOX_LAYOUT (actor), for_height,
                               min_width_p, natural_width_p);

  st_theme_node_adjust_preferred_width (theme_node,
                                        min_width_p, natural_width_p);
}

static void
get_content_preferred_height (StBoxLayout *self,
                              gfloat       for_width,
                              gfloat      *min_height_p,
                              gfloat      *natural_height_p)
{
  StBoxLayoutPrivate *priv = self->priv;
  gint n_children = 0;
  gfloat min_height, natural_height;
  GList *l;

  min_height = 0;
  natural_height = 0;

  for (l = priv->children; l; l = g_list_next (l))
    {
      gfloat child_min = 0, child_nat = 0;

      if (!CLUTTER_ACTOR_IS_VISIBLE ((ClutterActor*) l->data))
        continue;

      n_children++;

      clutter_actor_get_preferred_height ((ClutterActor*) l->data,
                                          (priv->is_vertical) ? for_width : -1,
                                          &child_min,
                                          &child_nat);

      if (!priv->is_vertical)
        {
          min_height = MAX (child_min, min_height);
          natural_height = MAX (child_nat, natural_height);
        }
      else
        {
          min_height += child_min;
          natural_height += child_nat;
        }
    }

  if (priv->is_vertical && n_children > 1)
    {
      min_height += priv->spacing * (n_children - 1);
      natural_height += priv->spacing * (n_children - 1);
    }

  if (min_height_p)
    *min_height_p = min_height;

  if (natural_height_p)
    *natural_height_p = natural_height;
}

static void
st_box_layout_get_preferred_height (ClutterActor *actor,
                                    gfloat        for_width,
                                    gfloat       *min_height_p,
                                    gfloat       *natural_height_p)
{
  StThemeNode *theme_node = st_widget_get_theme_node (ST_WIDGET (actor));

  st_theme_node_adjust_for_width (theme_node, &for_width);

  get_content_preferred_height (ST_BOX_LAYOUT (actor), for_width,
                                min_height_p, natural_height_p);

  st_theme_node_adjust_preferred_height (theme_node,
                                         min_height_p, natural_height_p);
}

static void
st_box_layout_allocate (ClutterActor          *actor,
                        const ClutterActorBox *box,
                        ClutterAllocationFlags flags)
{
  StBoxLayoutPrivate *priv = ST_BOX_LAYOUT (actor)->priv;
  StThemeNode *theme_node = st_widget_get_theme_node (ST_WIDGET (actor));
  ClutterActorBox content_box;
  gfloat avail_width, avail_height, pref_width, pref_height;
  gfloat position = 0;
  GList *l;
  gint n_expand_children, extra_space;

  CLUTTER_ACTOR_CLASS (st_box_layout_parent_class)->allocate (actor, box,
                                                              flags);

  if (priv->children == NULL)
    return;

  st_theme_node_get_content_box (theme_node, box, &content_box);

  avail_width  = content_box.x2 - content_box.x1;
  avail_height = content_box.y2 - content_box.y1;

  get_content_preferred_height (ST_BOX_LAYOUT (actor), avail_width,
                                NULL, &pref_height);
  get_content_preferred_width (ST_BOX_LAYOUT (actor), avail_height,
                               NULL, &pref_width);

  /* update adjustments for scrolling */
  if (priv->vadjustment)
    {
      gdouble prev_value;

      g_object_set (G_OBJECT (priv->vadjustment),
                    "lower", 0.0,
                    "upper", pref_height,
                    "page-size", avail_height,
                    "step-increment", avail_height / 6,
                    "page-increment", avail_height,
                    NULL);

      prev_value = st_adjustment_get_value (priv->vadjustment);
      st_adjustment_set_value (priv->vadjustment, prev_value);
    }

  if (priv->hadjustment)
    {
      gdouble prev_value;

      g_object_set (G_OBJECT (priv->hadjustment),
                    "lower", 0.0,
                    "upper", pref_width,
                    "page-size", avail_width,
                    "step-increment", avail_width / 6,
                    "page-increment", avail_width,
                    NULL);

      prev_value = st_adjustment_get_value (priv->hadjustment);
      st_adjustment_set_value (priv->hadjustment, prev_value);
    }

  /* count the number of children with expand set to TRUE */
  n_expand_children = 0;
  for (l = priv->children; l; l = l->next)
    {
      gboolean expand;

      if (!CLUTTER_ACTOR_IS_VISIBLE (l->data))
        continue;

      clutter_container_child_get ((ClutterContainer *) actor,
                                   (ClutterActor*) l->data,
                                   "expand", &expand,
                                   NULL);
      if (expand)
        n_expand_children++;
    }

  if (n_expand_children == 0)
    {
      extra_space = 0;
      n_expand_children = 1;
    }
  else
    {
      if (priv->is_vertical)
        extra_space = (avail_height - pref_height) / n_expand_children;
      else
        extra_space = (avail_width - pref_width) / n_expand_children;

      /* don't shrink anything */
      if (extra_space < 0)
        extra_space = 0;
    }

  if (priv->is_vertical)
    position = content_box.y1;
  else
    position = content_box.x1;

  if (priv->is_pack_start)
    l = g_list_last (priv->children);
  else
    l = priv->children;

  for (l = (priv->is_pack_start) ? g_list_last (priv->children) : priv->children;
       l;
       l = (priv->is_pack_start) ? l->prev : l->next)
    {
      ClutterActor *child = (ClutterActor*) l->data;
      ClutterActorBox child_box;
      gfloat child_nat;
      gboolean xfill, yfill, expand;
      StAlign xalign, yalign;

      if (!CLUTTER_ACTOR_IS_VISIBLE (child))
        continue;

      clutter_container_child_get ((ClutterContainer*) actor, child,
                                   "x-fill", &xfill,
                                   "y-fill", &yfill,
                                   "x-align", &xalign,
                                   "y-align", &yalign,
                                   "expand", &expand,
                                   NULL);

      if (priv->is_vertical)
        {
          clutter_actor_get_preferred_height (child, avail_width,
                                              NULL, &child_nat);

          child_box.y1 = position;
          if (expand)
            child_box.y2 = position + child_nat + extra_space;
          else
            child_box.y2 = position + child_nat;
          child_box.x1 = content_box.x1;
          child_box.x2 = content_box.x2;

          _st_allocate_fill (child, &child_box, xalign, yalign, xfill, yfill);
          clutter_actor_allocate (child, &child_box, flags);

          if (expand)
            position += (child_nat + priv->spacing + extra_space);
          else
            position += (child_nat + priv->spacing);
        }
      else
        {

          clutter_actor_get_preferred_width (child, avail_height,
                                             NULL, &child_nat);

          child_box.x1 = position;

          if (expand)
            child_box.x2 = position + child_nat + extra_space;
          else
            child_box.x2 = position + child_nat;

          child_box.y1 = content_box.y1;
          child_box.y2 = content_box.y2;
          _st_allocate_fill (child, &child_box, xalign, yalign, xfill, yfill);
          clutter_actor_allocate (child, &child_box, flags);

          if (expand)
            position += (child_nat + priv->spacing + extra_space);
          else
            position += (child_nat + priv->spacing);
        }
    }
}

static void
st_box_layout_apply_transform (ClutterActor *a,
                               CoglMatrix   *m)
{
  StBoxLayoutPrivate *priv = ST_BOX_LAYOUT (a)->priv;
  gdouble x, y;

  CLUTTER_ACTOR_CLASS (st_box_layout_parent_class)->apply_transform (a, m);

  if (priv->hadjustment)
    x = st_adjustment_get_value (priv->hadjustment);
  else
    x = 0;

  if (priv->vadjustment)
    y = st_adjustment_get_value (priv->vadjustment);
  else
    y = 0;

  cogl_matrix_translate (m, (int) -x, (int) -y, 0);
}


static void
st_box_layout_paint (ClutterActor *actor)
{
  StBoxLayoutPrivate *priv = ST_BOX_LAYOUT (actor)->priv;
  GList *l;
  gdouble x, y;
  ClutterActorBox child_b;
  ClutterActorBox box_b;

  CLUTTER_ACTOR_CLASS (st_box_layout_parent_class)->paint (actor);

  if (priv->children == NULL)
    return;

  if (priv->hadjustment)
    x = st_adjustment_get_value (priv->hadjustment);
  else
    x = 0;

  if (priv->vadjustment)
    y = st_adjustment_get_value (priv->vadjustment);
  else
    y = 0;

  clutter_actor_get_allocation_box (actor, &box_b);
  box_b.x2 = (box_b.x2 - box_b.x1) + x;
  box_b.x1 = x;
  box_b.y2 = (box_b.y2 - box_b.y1) + y;
  box_b.y1 = y;

  for (l = priv->children; l; l = g_list_next (l))
    {
      ClutterActor *child = (ClutterActor*) l->data;

      if (!CLUTTER_ACTOR_IS_VISIBLE (child))
        continue;

      clutter_actor_get_allocation_box (child, &child_b);

      if ((child_b.x1 < box_b.x2) &&
          (child_b.x2 > box_b.x1) &&
          (child_b.y1 < box_b.y2) &&
          (child_b.y2 > box_b.y1))
        {
          clutter_actor_paint (child);
        }
    }
}

static void
st_box_layout_pick (ClutterActor       *actor,
                    const ClutterColor *color)
{
  StBoxLayoutPrivate *priv = ST_BOX_LAYOUT (actor)->priv;
  GList *l;
  gdouble x, y;
  ClutterActorBox child_b;
  ClutterActorBox box_b;

  CLUTTER_ACTOR_CLASS (st_box_layout_parent_class)->pick (actor, color);

  if (priv->children == NULL)
    return;

  if (priv->hadjustment)
    x = st_adjustment_get_value (priv->hadjustment);
  else
    x = 0;

  if (priv->vadjustment)
    y = st_adjustment_get_value (priv->vadjustment);
  else
    y = 0;

  clutter_actor_get_allocation_box (actor, &box_b);
  box_b.x2 = (box_b.x2 - box_b.x1) + x;
  box_b.x1 = x;
  box_b.y2 = (box_b.y2 - box_b.y1) + y;
  box_b.y1 = y;

  for (l = priv->children; l; l = g_list_next (l))
    {
      ClutterActor *child = (ClutterActor*) l->data;

      if (!CLUTTER_ACTOR_IS_VISIBLE (child))
        continue;

      clutter_actor_get_allocation_box (child, &child_b);

      if ((child_b.x1 < box_b.x2)
          && (child_b.x2 > box_b.x1)
          && (child_b.y1 < box_b.y2)
          && (child_b.y2 > box_b.y1))
        {
          clutter_actor_paint (child);
        }
    }
}

static void
st_box_layout_class_init (StBoxLayoutClass *klass)
{
  GObjectClass *object_class = G_OBJECT_CLASS (klass);
  ClutterActorClass *actor_class = CLUTTER_ACTOR_CLASS (klass);
  GParamSpec *pspec;

  g_type_class_add_private (klass, sizeof (StBoxLayoutPrivate));

  object_class->get_property = st_box_layout_get_property;
  object_class->set_property = st_box_layout_set_property;
  object_class->dispose = st_box_layout_dispose;

  actor_class->allocate = st_box_layout_allocate;
  actor_class->get_preferred_width = st_box_layout_get_preferred_width;
  actor_class->get_preferred_height = st_box_layout_get_preferred_height;
  actor_class->apply_transform = st_box_layout_apply_transform;

  actor_class->paint = st_box_layout_paint;
  actor_class->pick = st_box_layout_pick;

  pspec = g_param_spec_boolean ("vertical",
                                "Vertical",
                                "Whether the layout should be vertical, rather"
                                "than horizontal",
                                FALSE,
                                ST_PARAM_READWRITE);
  g_object_class_install_property (object_class, PROP_VERTICAL, pspec);

  pspec = g_param_spec_boolean ("pack-start",
                                "Pack Start",
                                "Whether to pack items at the start of the box",
                                FALSE,
                                ST_PARAM_READWRITE);
  g_object_class_install_property (object_class, PROP_PACK_START, pspec);

  pspec = g_param_spec_uint ("spacing",
                             "Spacing",
                             "Spacing between children",
                             0, G_MAXUINT, 0,
                             ST_PARAM_READWRITE);
  g_object_class_install_property (object_class, PROP_SPACING, pspec);

  /* StScrollable properties */
  g_object_class_override_property (object_class,
                                    PROP_HADJUST,
                                    "hadjustment");

  g_object_class_override_property (object_class,
                                    PROP_VADJUST,
                                    "vadjustment");

}

static void
st_box_layout_init (StBoxLayout *self)
{
  self->priv = BOX_LAYOUT_PRIVATE (self);
}

/**
 * st_box_layout_new:
 *
 * Create a new #StBoxLayout.
 *
 * Returns: a newly allocated #StBoxLayout
 */
StWidget *
st_box_layout_new (void)
{
  return g_object_new (ST_TYPE_BOX_LAYOUT, NULL);
}

/**
 * st_box_layout_set_vertical:
 * @box: A #StBoxLayout
 * @vertical: #TRUE if the layout should be vertical
 *
 * Set the value of the #StBoxLayout::vertical property
 *
 */
void
st_box_layout_set_vertical (StBoxLayout *box,
                            gboolean     vertical)
{
  g_return_if_fail (ST_IS_BOX_LAYOUT (box));

  if (box->priv->is_vertical != vertical)
    {
      box->priv->is_vertical = vertical;
      clutter_actor_queue_relayout ((ClutterActor*) box);

      g_object_notify (G_OBJECT (box), "vertical");
    }
}

/**
 * st_box_layout_get_vertical:
 * @box: A #StBoxLayout
 *
 * Get the value of the #StBoxLayout::vertical property.
 *
 * Returns: #TRUE if the layout is vertical
 */
gboolean
st_box_layout_get_vertical (StBoxLayout *box)
{
  g_return_val_if_fail (ST_IS_BOX_LAYOUT (box), FALSE);

  return box->priv->is_vertical;
}

/**
 * st_box_layout_set_pack_start:
 * @box: A #StBoxLayout
 * @pack_start: #TRUE if the layout should use pack-start
 *
 * Set the value of the #StBoxLayout::pack-start property.
 *
 */
void
st_box_layout_set_pack_start (StBoxLayout *box,
                              gboolean     pack_start)
{
  g_return_if_fail (ST_IS_BOX_LAYOUT (box));

  if (box->priv->is_pack_start != pack_start)
    {
      box->priv->is_pack_start = pack_start;
      clutter_actor_queue_relayout ((ClutterActor*) box);

      g_object_notify (G_OBJECT (box), "pack-start");
    }
}

/**
 * st_box_layout_get_pack_start:
 * @box: A #StBoxLayout
 *
 * Get the value of the #StBoxLayout::pack-start property.
 *
 * Returns: #TRUE if pack-start is enabled
 */
gboolean
st_box_layout_get_pack_start (StBoxLayout *box)
{
  g_return_val_if_fail (ST_IS_BOX_LAYOUT (box), FALSE);

  return box->priv->is_pack_start;
}

/**
 * st_box_layout_set_spacing:
 * @box: A #StBoxLayout
 * @spacing: the spacing value
 *
 * Set the amount of spacing between children in pixels
 *
 */
void
st_box_layout_set_spacing (StBoxLayout *box,
                           guint        spacing)
{
  StBoxLayoutPrivate *priv;

  g_return_if_fail (ST_IS_BOX_LAYOUT (box));

  priv = box->priv;

  if (priv->spacing != spacing)
    {
      priv->spacing = spacing;

      clutter_actor_queue_relayout (CLUTTER_ACTOR (box));

      g_object_notify (G_OBJECT (box), "spacing");
    }
}

/**
 * st_box_layout_get_spacing:
 * @box: A #StBoxLayout
 *
 * Get the spacing between children in pixels
 *
 * Returns: the spacing value
 */
guint
st_box_layout_get_spacing (StBoxLayout *box)
{
  g_return_val_if_fail (ST_IS_BOX_LAYOUT (box), 0);

  return box->priv->spacing;
}
